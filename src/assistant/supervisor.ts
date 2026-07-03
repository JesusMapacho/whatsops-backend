import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StateGraph, START, END } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AuthUser } from '../auth/current-user.decorator';
import { buildChatModel, readLlmConfig } from './llm';
import { AssistantState, AssistantStateType, BranchResult, UiAction } from './state';
import { classifyIntent, branchesFor } from './router';
import { detectInjection, sanitizeInput } from './gatekeeper';
import { BranchBService } from './rag/branch-b.service';
import { BranchAService } from './mutations/branch-a.service';
import { synthesize } from './synthesis';

export interface AssistantReply {
  reply: string;
  actions: AssistantStateType['actions'];
}

@Injectable()
export class SupervisorService {
  private readonly log = new Logger('Assistant');
  private modelPromise?: Promise<BaseChatModel>;
  private graph?: ReturnType<typeof this.buildGraph>;

  constructor(
    private readonly config: ConfigService,
    private readonly branchB: BranchBService,
    private readonly branchA: BranchAService,
  ) {}

  private model(): Promise<BaseChatModel> {
    // Construcción perezosa y cacheada: el modelo agnóstico se resuelve async.
    this.modelPromise ??= buildChatModel(readLlmConfig(this.config)) as Promise<BaseChatModel>;
    return this.modelPromise;
  }

  // ── Registro extensible de ramas ────────────────────────────────────────────
  // Sumar capacidades futuras (v2/v4) = añadir aquí un worker, sin tocar el bucle.
  private async branchQuery(state: AssistantStateType): Promise<Partial<AssistantStateType>> {
    return this.runBranch('query', async () =>
      this.branchB.run(await this.model(), state.tenantId, lastUserText(state)),
    );
  }

  private async branchMutation(state: AssistantStateType): Promise<Partial<AssistantStateType>> {
    return this.runBranch('mutation', async () =>
      this.branchA.run(
        await this.model(),
        { tenantId: state.tenantId, role: state.role, userId: state.userId },
        lastUserText(state),
      ),
    );
  }

  // Aísla el error de una rama: nunca tumba el grafo, lo registra en branchResults.
  private async runBranch(
    branch: BranchResult['branch'],
    work: () => Promise<unknown>,
  ): Promise<Partial<AssistantStateType>> {
    try {
      return { branchResults: [{ branch, ok: true, data: await work() }] };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.log.warn(`Rama ${branch} falló: ${error}`);
      return { branchResults: [{ branch, ok: false, error }] };
    }
  }

  private async synthesize(state: AssistantStateType): Promise<Partial<AssistantStateType>> {
    const base = await synthesize(await this.model(), lastUserText(state), state.branchResults);
    // Las acciones de confirmación se derivan en código (no las inventa el LLM): el payload
    // debe ser exacto. Se anexan a las de navegación que sí sugiere la síntesis.
    return { ...base, actions: [...base.actions, ...confirmActions(state.branchResults)] };
  }

  private buildGraph() {
    const g = new StateGraph(AssistantState)
      .addNode('router', async (state) => {
        const text = lastUserText(state);
        const route = await classifyIntent(await this.model(), text);
        return { route };
      })
      .addNode('branchQuery', (s) => this.branchQuery(s))
      .addNode('branchMutation', (s) => this.branchMutation(s))
      .addNode('synthesize', (s) => this.synthesize(s))
      .addEdge(START, 'router')
      .addConditionalEdges('router', (state) => dispatch(state), [
        'branchQuery',
        'branchMutation',
        'synthesize',
      ])
      .addEdge('branchQuery', 'synthesize')
      .addEdge('branchMutation', 'synthesize')
      .addEdge('synthesize', END);
    return g.compile();
  }

  async run(user: AuthUser, messages: Array<{ role: string; content: string }>): Promise<AssistantReply> {
    const last = messages[messages.length - 1];
    const text = sanitizeInput(last?.content);
    if (detectInjection(text)) this.log.warn(`Posible prompt-injection (tenant ${user.tenantId})`);

    this.graph ??= this.buildGraph();
    const result = await this.graph.invoke({
      messages: [{ role: 'user', content: text }],
      tenantId: user.tenantId,
      role: user.role,
      userId: user.userId,
    });
    return { reply: result.reply ?? '', actions: result.actions ?? [] };
  }

  // Ejecuta una mutación confirmada por el usuario (botón del widget). La identidad viene
  // del JWT; el payload solo aporta qué conversación/tool, y ConversationsService revalida.
  async confirm(
    user: AuthUser,
    body: { tool: string; conversationId: string; args?: { status?: string; note?: string } },
  ): Promise<AssistantReply> {
    const res = await this.branchA.execute(
      body.tool,
      { tenantId: user.tenantId, role: user.role, userId: user.userId },
      body.conversationId,
      body.args ?? {},
    );
    return { reply: res.summary, actions: [] };
  }
}

// Convierte las mutaciones pendientes (data.pending) en acciones de confirmación de UI.
export function confirmActions(results: BranchResult[]): UiAction[] {
  const out: UiAction[] = [];
  for (const r of results) {
    if (r.ok && r.branch === 'mutation' && r.data && typeof r.data === 'object' && 'pending' in r.data) {
      const p = (r.data as { pending: { tool: string; conversationId: string; args?: { status?: string; note?: string }; summary: string } }).pending;
      out.push({
        type: 'confirm',
        label: `Confirmar: ${p.summary}`,
        confirm: { tool: p.tool, conversationId: p.conversationId, args: p.args },
      });
    }
  }
  return out;
}

// ── Helpers puros (testeables sin LLM) ─────────────────────────────────────────
export function lastUserText(state: Pick<AssistantStateType, 'messages'>): string {
  const msgs = state.messages ?? [];
  const last = msgs[msgs.length - 1] as { content?: unknown } | undefined;
  return typeof last?.content === 'string' ? last.content : '';
}

// Decisión de despacho: intención → nombres de nodo (paralelo, estado compartido),
// o directo a síntesis si no hay rama. Devolver varios nombres corre las ramas en paralelo.
export function dispatch(state: Pick<AssistantStateType, 'route'>): string[] {
  const targets = branchesFor(state.route ?? { needsQuery: false, needsMutation: false });
  return targets.length ? targets : ['synthesize'];
}
