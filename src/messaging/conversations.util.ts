import { Prisma, ConversationStatus } from '@prisma/client';

export type ConversationFilter = 'open' | 'mine' | 'unassigned' | 'frio';

// Tope de la bandeja. Antes no había ninguno, y con envíos en frío una lista sin
// tope significa pintar 5000 conversaciones y meter 5000 ids en el IN del conteo
// de no-leídos.
// ponytail: sin paginación real. Upgrade cuando alguien pida ver más allá de 200:
// cursor por `updatedAt`, que ya es el orden.
export const INBOX_TAKE = 200;

// Un agente solo puede ver/actuar sobre conversaciones suyas o abiertas, y **nunca** las de
// un contacto marcado como privado. El admin no tiene esta restricción.
//
// Lo de `privado` no es una comodidad: emparejar por QR mete en la bandeja todos los chats
// del teléfono del dueño (el filtro de `decode.ts` es lista negra a propósito), y como las
// conversaciones nacen `open`, sin este `AND` cualquier agente leía la conversación del
// dueño con su médico desde el primer mensaje.
//
// Va como `AND` y no dentro del `OR`: un filtro que se mezcle con el alcance por rol lo
// puede pisar, y ese es el error de esta familia de funciones (ver el bucle de
// conversations.util.check.ts, que lo comprueba sobre el where final).
export function agentScope(
  role: string,
  userId: string,
): Prisma.ConversationWhereInput {
  if (role === 'admin') return {};
  return {
    AND: [
      { OR: [{ assignedUserId: userId }, { status: 'open' }] },
      { contact: { privado: false } },
    ],
  };
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

  // Los filtros se AÑADEN al `AND` que ya trajera la base, nunca lo reemplazan.
  //
  // Antes era `{ ...base, AND: extra }`, que pisaba la clave. Con `agentScope` devolviendo
  // ahora un `AND` (para excluir los contactos privados), esa línea habría borrado el
  // alcance del agente en cuanto alguien escribiera en el buscador: teclear una letra
  // abría la bandeja entera, incluidas las conversaciones privadas del dueño. Es el error
  // clásico de esta familia de `build*Where` y por eso el check lo comprueba sobre el
  // where final, filtro por filtro.
  const withExtra = (base: Prisma.ConversationWhereInput): Prisma.ConversationWhereInput => {
    if (!extra.length) return base;
    const previos = base.AND ? (Array.isArray(base.AND) ? base.AND : [base.AND]) : [];
    return { ...base, AND: [...previos, ...extra] };
  };

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
    // En frío = nunca nos han contestado. Es `lastInboundAt: null`, no "fuera de la
    // ventana": quien escribió hace tres días ya nos conoce. Es la vista de "a quién
    // le escribí y no me ha contestado".
    case 'frio':
      return withExtra({ tenantId, lastInboundAt: null });
    default:
      return withExtra({ tenantId });
  }
}

// Campos del último mensaje que la lista necesita para pintar la previsualización.
// Se traen con `take: 1` dentro de la misma query, no en una segunda ronda.
export const LAST_MESSAGE_SELECT = {
  id: true,
  conversationId: true,
  direction: true,
  type: true,
  payload: true,
  wamid: true,
  status: true,
  deletedAt: true,
  createdAt: true,
} as const;

/**
 * Aplana una fila de la lista: saca el `messages` del include (que trae como mucho
 * uno) y lo publica como `lastMessage`. Importa que `messages` NO viaje en la
 * respuesta: un array casi vacío en cada fila confunde al cliente y engorda el JSON.
 *
 * `sign` convierte la key de la foto del contacto en una URL firmada. La key sola no
 * le sirve de nada al navegador y las URLs caducan, así que se firma al serializar,
 * igual que hace `withMediaUrl` con los adjuntos.
 */
export function shapeConversationRow<
  T extends { id: string; messages?: unknown[]; contact?: { avatarKey?: string | null } | null },
>(
  row: T,
  unread: number,
  sign: (key: string) => string,
): Omit<T, 'messages'> & { unread: number; lastMessage: unknown | null } {
  const { messages, ...rest } = row;
  const contact = rest.contact
    ? { ...rest.contact, avatarUrl: rest.contact.avatarKey ? sign(rest.contact.avatarKey) : null }
    : rest.contact;
  return { ...rest, contact, unread, lastMessage: messages?.[0] ?? null };
}

const STATUSES: ConversationStatus[] = ['open', 'pending', 'closed'];

// Valida el status entrante del cliente; lanza si no es del enum.
export function parseStatus(v: unknown): ConversationStatus {
  if (typeof v === 'string' && (STATUSES as string[]).includes(v)) {
    return v as ConversationStatus;
  }
  throw new Error('status debe ser open, pending o closed');
}
