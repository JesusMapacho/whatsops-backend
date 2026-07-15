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

// Búsqueda por texto: nombre/waId del contacto o cuerpo del mensaje.
// ponytail: el cuerpo del mensaje es `string_contains` sobre JSON (case-SENSITIVE
// en Postgres vía Prisma). Camino de upgrade si crece: full-text con tsvector.
function searchWhere(q: string): Prisma.ConversationWhereInput {
  return {
    OR: [
      { contact: { name: { contains: q, mode: 'insensitive' } } },
      { contact: { waId: { contains: q } } },
      { messages: { some: { payload: { path: ['text', 'body'], string_contains: q } } } },
    ],
  };
}

// Construye el where de la lista de conversaciones según el filtro. Siempre
// acotado por tenantId; nunca cruza tenants. El agente queda restringido a las
// suyas + abiertas sin importar el filtro. `q`/`assignedUserId` solo restringen.
export function buildConversationWhere(
  tenantId: string,
  filter: ConversationFilter | string | undefined,
  userId: string,
  role: string,
  q?: string,
  assignedUserId?: string,
): Prisma.ConversationWhereInput {
  const extra: Prisma.ConversationWhereInput[] = [];
  if (q?.trim()) extra.push(searchWhere(q.trim()));
  if (assignedUserId) extra.push({ assignedUserId });
  const withExtra = (base: Prisma.ConversationWhereInput): Prisma.ConversationWhereInput =>
    extra.length ? { ...base, AND: extra } : base;

  if (role !== 'admin') {
    return withExtra({ tenantId, ...agentScope(role, userId) });
  }
  switch (filter) {
    case 'mine':
      return withExtra({ tenantId, assignedUserId: userId });
    case 'unassigned':
      return withExtra({ tenantId, assignedUserId: null });
    case 'open':
      return withExtra({ tenantId, status: 'open' });
    default:
      return withExtra({ tenantId });
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
