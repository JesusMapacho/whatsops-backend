import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export interface Intent {
  needsQuery: boolean; // consultar/leer datos → Rama B
  needsMutation: boolean; // asignar/cerrar/modificar → Rama A
}

const IntentSchema = z.object({
  needsQuery: z.boolean().describe('El usuario pide leer/consultar datos (contar, listar, buscar).'),
  needsMutation: z
    .boolean()
    .describe('El usuario pide una acción que modifica datos (asignar, cerrar, crear nota).'),
});

const SYSTEM = [
  'Clasifica la intención del mensaje del usuario en una app de atención por WhatsApp.',
  'needsQuery = pide leer/consultar (¿cuántas...?, muéstrame, lista, busca).',
  'needsMutation = pide una acción que cambia datos (asigna, cierra, crea nota, marca).',
  'Una petición mixta activa ambos. Si no pide ni una ni otra, ambos false.',
].join(' ');

// Clasificador semántico. El SQL/las mutaciones nunca se derivan de aquí: esto solo
// decide a qué rama(s) despachar.
export async function classifyIntent(model: BaseChatModel, text: string): Promise<Intent> {
  const structured = model.withStructuredOutput(IntentSchema, { name: 'intent' });
  return structured.invoke([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: text },
  ]) as Promise<Intent>;
}

// Mapeo puro (testeable sin LLM) intención → nodos a ejecutar.
export function branchesFor(intent: Intent): Array<'branchQuery' | 'branchMutation'> {
  const out: Array<'branchQuery' | 'branchMutation'> = [];
  if (intent.needsQuery) out.push('branchQuery');
  if (intent.needsMutation) out.push('branchMutation');
  return out;
}
