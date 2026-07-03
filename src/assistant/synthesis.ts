import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { BranchResult, UiAction } from './state';

// Rutas de navegación permitidas (deben existir en el frontend, app.config.ts).
export const ALLOWED_ROUTES = [
  '/',
  '/conexiones',
  '/bandeja',
  '/auditoria',
  '/usuarios',
  '/roles',
  '/perfil',
  '/facturacion',
  '/logs',
] as const;

const SynthesisSchema = z.object({
  reply: z.string().describe('Respuesta final para el usuario, en español, concisa.'),
  actions: z
    .array(
      z.object({
        type: z.enum(['navigate']),
        target: z.string().describe('Ruta del frontend, p. ej. /bandeja'),
        label: z.string().optional(),
      }),
    )
    .describe('Acciones de UI opcionales (navegación). Vacío si no aplica.'),
});

// Filtra acciones a rutas conocidas (no confiar en rutas inventadas por el LLM).
function safeActions(actions: UiAction[]): UiAction[] {
  return actions.filter(
    (a) => a.type === 'navigate' && !!a.target && (ALLOWED_ROUTES as readonly string[]).includes(a.target),
  );
}

// Agente de Síntesis: unifica las salidas de las ramas en la respuesta final. No inventa
// datos (solo usa lo que devolvieron las ramas), cita el origen y puede sugerir navegación.
export async function synthesize(
  model: BaseChatModel,
  question: string,
  results: BranchResult[],
): Promise<{ reply: string; actions: UiAction[] }> {
  const context = results.length
    ? results
        .map((r) =>
          r.ok
            ? `Rama ${r.branch} (OK): ${JSON.stringify(r.data)}`
            : `Rama ${r.branch} (ERROR): ${r.error}`,
        )
        .join('\n')
    : '(sin resultados de ramas: es una consulta conversacional o no requirió datos)';

  const system = [
    'Eres el asistente de WhatsOps (atención por WhatsApp). Responde en español, breve y claro.',
    'USA SOLO los datos de las ramas de abajo. No inventes cifras ni registros.',
    'Si una rama devolvió error, dilo con naturalidad y no inventes el resultado.',
    'Si hay contradicción entre ramas, explícala. Cita de qué provino el dato cuando ayude.',
    `Puedes sugerir navegación con actions (solo estas rutas: ${ALLOWED_ROUTES.join(', ')}).`,
    'RESULTADOS DE RAMAS:\n' + context,
  ].join('\n');

  const out = (await model
    .withStructuredOutput(SynthesisSchema, { name: 'synthesis' })
    .invoke([
      { role: 'system', content: system },
      { role: 'user', content: question },
    ])) as z.infer<typeof SynthesisSchema>;

  return { reply: out.reply, actions: safeActions(out.actions as UiAction[]) };
}
