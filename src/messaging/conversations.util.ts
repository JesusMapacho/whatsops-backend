import { Prisma, ConversationStatus } from '@prisma/client';

export type ConversationFilter = 'open' | 'mine' | 'unassigned';

// Un agente solo puede ver/actuar sobre conversaciones suyas o abiertas.
// El admin no tiene esta restricción.
export function agentScope(
  role: string,
  userId: string,
): Prisma.ConversationWhereInput {
  if (role === 'admin') return {};
  return { OR: [{ assignedUserId: userId }, { status: 'open' }] };
}

// Where de una conversación concreta con el alcance del agente aplicado.
export function conversationScopeWhere(
  tenantId: string,
  id: string,
  userId: string,
  role: string,
): Prisma.ConversationWhereInput {
  return { id, tenantId, ...agentScope(role, userId) };
}

// Construye el where de la lista de conversaciones según el filtro. Siempre
// acotado por tenantId; nunca cruza tenants. El agente queda restringido a las
// suyas + abiertas sin importar el filtro.
export function buildConversationWhere(
  tenantId: string,
  filter: ConversationFilter | string | undefined,
  userId: string,
  role: string,
): Prisma.ConversationWhereInput {
  if (role !== 'admin') {
    return { tenantId, ...agentScope(role, userId) };
  }
  switch (filter) {
    case 'mine':
      return { tenantId, assignedUserId: userId };
    case 'unassigned':
      return { tenantId, assignedUserId: null };
    case 'open':
      return { tenantId, status: 'open' };
    default:
      return { tenantId };
  }
}

const STATUSES: ConversationStatus[] = ['open', 'pending', 'closed'];

// Valida el status entrante del cliente; lanza si no es del enum.
export function parseStatus(v: unknown): ConversationStatus {
  if (typeof v === 'string' && (STATUSES as string[]).includes(v)) {
    return v as ConversationStatus;
  }
  throw new Error('status debe ser open, pending o closed');
}
