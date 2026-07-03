import { Annotation, MessagesAnnotation } from '@langchain/langgraph';

// Resultado de una rama: filas (Rama B), efecto de mutación (Rama A), o error capturado.
export interface BranchResult {
  branch: 'query' | 'mutation';
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface UiAction {
  type: 'navigate' | 'open';
  target: string; // ruta Angular o URL
  label?: string;
}

// Estado del grafo. tenantId/role/userId son datos de CONFIANZA del backend (JWT),
// jamás del contenido del prompt. Los resultados de rama se acumulan (concat).
export const AssistantState = Annotation.Root({
  ...MessagesAnnotation.spec,
  tenantId: Annotation<string>(),
  role: Annotation<string>(),
  userId: Annotation<string>(),
  route: Annotation<{ needsQuery: boolean; needsMutation: boolean }>(),
  branchResults: Annotation<BranchResult[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  reply: Annotation<string>(),
  actions: Annotation<UiAction[]>(),
});

export type AssistantStateType = typeof AssistantState.State;
