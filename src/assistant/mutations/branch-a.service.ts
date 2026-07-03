import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ConversationsService } from '../../messaging/conversations.service';
import { ErrorLogsService } from '../../observability/error-logs.service';

// Identidad de CONFIANZA (del JWT, nunca del prompt). Toda mutación se acota con esto.
export interface Ident {
  tenantId: string;
  role: string;
  userId: string;
}

export interface ExecuteArgs {
  status?: string;
  note?: string;
}

// El LLM solo PROPONE (tool + args); la autorización y la escritura real ocurren en
// código, llamando a ConversationsService (que ya exige tenantId + assertAccess).
const MutationSchema = z.object({
  tool: z.enum(['assign', 'setStatus', 'addNote']),
  conversationRef: z
    .string()
    .describe('Nombre del contacto o su teléfono (waId), tal como lo menciona el usuario.'),
  status: z.enum(['open', 'pending', 'closed']).optional().describe('Solo si tool=setStatus.'),
  note: z.string().optional().describe('Solo si tool=addNote: el texto de la nota.'),
});
type Mutation = z.infer<typeof MutationSchema>;

export const MUTATION_TOOLS = ['assign', 'setStatus', 'addNote'] as const;
export type MutationTool = (typeof MUTATION_TOOLS)[number];

// ── Lógica pura (testeable sin LLM/BD) ──────────────────────────────────────
// Cerrar es la única acción destructiva del set: requiere confirmación del usuario.
export function isDestructive(tool: string, status?: string): boolean {
  return tool === 'setStatus' && status === 'closed';
}

// Allowlist estricta: rechaza cualquier tool fuera del set, venga del LLM o del cliente.
export function assertTool(tool: string): asserts tool is MutationTool {
  if (!(MUTATION_TOOLS as readonly string[]).includes(tool)) {
    throw new BadRequestException(`Herramienta no permitida: ${tool}`);
  }
}

// Rama A: mutaciones por lenguaje natural. Envuelve los servicios de v1 (no duplica lógica).
@Injectable()
export class BranchAService {
  private readonly log = new Logger('Assistant:BranchA');

  constructor(
    private readonly conversations: ConversationsService,
    private readonly audit: ErrorLogsService,
  ) {}

  // Flujo completo: clasifica → resuelve conversación → ejecuta o pide confirmación (cerrar).
  async run(model: BaseChatModel, ident: Ident, question: string): Promise<unknown> {
    const m = await this.classify(model, question);
    const conv = await this.resolveOne(ident, m.conversationRef);

    if (isDestructive(m.tool, m.status)) {
      // No ejecuta: devuelve una acción pendiente; el supervisor la vuelve un botón de confirmar.
      return {
        pending: {
          tool: 'setStatus',
          conversationId: conv.id,
          args: { status: 'closed' },
          summary: `cerrar la conversación con ${conv.label}`,
        },
      };
    }
    return this.execute(m.tool, ident, conv.id, { status: m.status, note: m.note });
  }

  // Ejecuta la mutación y la audita. Reutilizado por el endpoint /confirm (acción destructiva).
  async execute(
    tool: string,
    ident: Ident,
    conversationId: string,
    args: ExecuteArgs,
  ): Promise<{ effect: unknown; summary: string }> {
    assertTool(tool);
    const { tenantId, role, userId } = ident;
    let effect: unknown;
    let summary: string;
    let action: string;

    switch (tool) {
      case 'assign':
        // ponytail: solo auto-asignación; asignar a otro agente por email = resolver User, pendiente.
        effect = await this.conversations.assign(tenantId, conversationId, undefined, userId, role);
        summary = 'Conversación asignada a ti.';
        action = `conversation.assign ${conversationId}`;
        break;
      case 'setStatus':
        effect = await this.conversations.setStatus(tenantId, conversationId, args.status, userId, role);
        summary = `Conversación marcada como ${args.status}.`;
        action = `conversation.setStatus:${args.status} ${conversationId}`;
        break;
      case 'addNote':
        effect = await this.conversations.addNote(tenantId, conversationId, userId, role, args.note);
        summary = 'Nota agregada.';
        action = `conversation.addNote ${conversationId}`;
        break;
    }

    this.audit.audit({ actorUserId: userId, tenantId, method: 'ASSISTANT', path: '/assistant', action: action! });
    return { effect, summary: summary! };
  }

  private async classify(model: BaseChatModel, question: string): Promise<Mutation> {
    const system = [
      'Extrae la acción de escritura pedida en una app de atención por WhatsApp.',
      'tool: assign (asignar la conversación al usuario actual), setStatus (open/pending/closed), addNote (agregar nota).',
      'conversationRef: nombre del contacto o su teléfono, tal como lo menciona el usuario.',
      'status: solo si tool=setStatus. note: solo si tool=addNote.',
    ].join(' ');
    return model.withStructuredOutput(MutationSchema, { name: 'mutation' }).invoke([
      { role: 'system', content: system },
      { role: 'user', content: question },
    ]) as Promise<Mutation>;
  }

  // Resuelve la referencia difusa a UNA conversación del tenant (reusa list, tenant-scoped).
  private async resolveOne(ident: Ident, ref: string): Promise<{ id: string; label: string }> {
    const needle = (ref ?? '').trim().toLowerCase();
    if (!needle) throw new BadRequestException('No entendí a qué conversación te refieres.');

    const convs = await this.conversations.list(ident.tenantId, undefined, ident.userId, ident.role);
    const hits = convs.filter((c) => {
      const name = (c.contact?.name ?? '').toLowerCase();
      const wa = (c.contact?.waId ?? '').toLowerCase();
      return name.includes(needle) || wa.includes(needle);
    });

    if (!hits.length) throw new BadRequestException(`No encontré ninguna conversación que coincida con "${ref}".`);
    if (hits.length > 1) {
      throw new BadRequestException(`Hay varias conversaciones que coinciden con "${ref}"; especifica el teléfono.`);
    }
    const c = hits[0];
    return { id: c.id, label: c.contact?.name || c.contact?.waId || c.id };
  }
}
