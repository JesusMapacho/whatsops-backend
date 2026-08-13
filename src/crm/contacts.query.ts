import { Prisma } from '@prisma/client';

// Tope de la lista de clientes, con el mismo criterio que `INBOX_TAKE`
// (`messaging/conversations.util.ts`): una lista sin tope significa pintar todos los
// contactos que ha acumulado un número de negocio.
// ponytail: sin paginación real. Upgrade cuando alguien pida ver más allá de 200: cursor
// por `updatedAt`, que ya es el orden.
export const CONTACTS_TAKE = 200;

export interface ContactFilters {
  q?: string;
  tagId?: string;
  ownerId?: string;
  // Contactos SIN ningún trato abierto: la lista de "gente que me escribió y todavía no he
  // metido al embudo", que es por donde se pierde el dinero cuando la regla de alta
  // automática está apagada.
  sinTrato?: boolean;
}

/**
 * Where de la lista de clientes. Siempre acotado por `tenantId`; los filtros solo
 * RESTRINGEN, nunca amplían.
 *
 * No hay alcance por rol aquí, y es deliberado: la ficha del cliente es de lectura y el
 * agente ya ve a todo el que le escribe desde la bandeja (`contacts:read` va en el rol
 * `agent`). Lo que sí se acota por dueño son los TRATOS, en `dealScope` — que es donde
 * está el dinero.
 */
export function buildContactWhere(
  tenantId: string,
  f: ContactFilters = {},
): Prisma.ContactWhereInput {
  const where: Prisma.ContactWhereInput = { tenantId };
  const q = f.q?.trim();
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { company: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      // `waId` y `phone` sin `mode` a propósito: son dígitos e ids externos, así que
      // insensible a mayúsculas no aporta y evita que Postgres descarte el índice.
      { waId: { contains: q } },
      { phone: { contains: q } },
    ];
  }
  if (f.tagId) where.tags = { some: { tagId: f.tagId } };
  if (f.ownerId) where.ownerId = f.ownerId;
  // `none` con el filtro de estado dentro: "ningún trato ABIERTO". Con `none: {}` a secas
  // saldrían solo los contactos sin ningún trato en su historia, y quien ya compró y
  // volvió a escribir es exactamente a quien hay que mirar.
  if (f.sinTrato) where.deals = { none: { status: 'open' } };
  return where;
}

// Normaliza los query params (que llegan como string o ausentes) a los filtros.
export function parseContactFilters(query: Record<string, unknown>): ContactFilters {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    q: str(query.q),
    tagId: str(query.tagId),
    ownerId: str(query.ownerId),
    // Solo el string 'true' cuenta. Con `Boolean(query.sinTrato)` un `?sinTrato=false`
    // filtraría, que es justo lo contrario de lo que dice la URL.
    sinTrato: query.sinTrato === 'true' || query.sinTrato === true,
  };
}

// Campos que la ficha permite editar. La IDENTIDAD (`waId`, `phone`, `platform`) NO está y
// no debe estar: es lo que empareja los mensajes entrantes con el contacto, y cambiarla a
// mano parte el hilo en dos.
const EDITABLES = ['name', 'email', 'company', 'ownerId'] as const;

export class ContactPatchError extends Error {}

/**
 * Filtra y valida el body de `PATCH /contacts/:id`.
 *
 * Allowlist y no denylist: con una denylist, cada columna nueva del modelo queda editable
 * por defecto y hay que acordarse de prohibirla.
 *
 * Cadena vacía se traduce a `null` (borrar el dato), no se ignora: si no, no habría forma
 * de quitar un correo mal escrito.
 */
// `Unchecked` y no `ContactUpdateInput`: el tipo "checked" expone la relación (`owner`) en
// vez de la FK, y aquí se escribe `ownerId` directo porque es lo que manda la UI.
export function parseContactPatch(body: unknown): Prisma.ContactUncheckedUpdateInput {
  if (!body || typeof body !== 'object') throw new ContactPatchError('Cuerpo inválido');
  const src = body as Record<string, unknown>;
  const data: Record<string, string | null> = {};
  for (const k of EDITABLES) {
    if (!(k in src)) continue;
    const v = src[k];
    if (v === null || v === '') {
      data[k] = null;
      continue;
    }
    if (typeof v !== 'string') throw new ContactPatchError(`${k} debe ser texto o null`);
    const t = v.trim();
    if (!t) {
      data[k] = null;
      continue;
    }
    if (k === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) {
      throw new ContactPatchError('Correo inválido');
    }
    data[k] = t;
  }
  if (!Object.keys(data).length) throw new ContactPatchError('Nada que actualizar');
  return data as Prisma.ContactUncheckedUpdateInput;
}

// Ids de etiquetas de `PUT /contacts/:id/tags`. Se manda el juego COMPLETO: un
// POST/DELETE por etiqueta convierte "quité dos y puse una" en tres peticiones que pueden
// quedar a medias, y la UI ya tiene el juego entero en la mano.
export function parseTagIds(body: unknown): string[] {
  const raw = (body as { tagIds?: unknown })?.tagIds;
  if (raw === undefined || raw === null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const ids = arr.filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => v.trim());
  // Deduplicado: la clave de `ContactTag` es (contactId, tagId), así que un id repetido
  // reventaría el `createMany` por clave duplicada en vez de ser un no-op.
  return [...new Set(ids)];
}
