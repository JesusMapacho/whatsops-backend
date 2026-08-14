import { DealStatus, Prisma } from '@prisma/client';
import { dealScope } from './deal-scope';

// Tope del tablero, con el mismo criterio que `INBOX_TAKE` y `CONTACTS_TAKE`.
// ponytail: sin paginación. Un tablero con más de 300 tratos abiertos ya no se lee como
// tablero; el camino de upgrade es la vista de lista, no paginar columnas.
export const DEALS_TAKE = 300;

export interface DealFilters {
  pipelineId?: string;
  ownerId?: string;
  tagId?: string;
  q?: string;
  status?: DealStatus;
}

export class DealError extends Error {}

/**
 * Where del tablero. Siempre acotado por `tenantId` y por `dealScope`; los filtros solo
 * restringen.
 *
 * Por defecto **solo los abiertos**: el tablero pinta etapas, y ganados y perdidos ya no
 * están en ninguna. Se piden explícitamente con `?status=`.
 */
export function buildDealWhere(
  tenantId: string,
  f: DealFilters,
  userId: string,
  role: string,
): Prisma.DealWhereInput {
  const where: Prisma.DealWhereInput = {
    tenantId,
    status: f.status ?? 'open',
    ...dealScope(role, userId),
  };
  if (f.pipelineId) where.pipelineId = f.pipelineId;
  // `ownerId` puede venir como 'ninguno' para pedir los que nadie ha reclamado, que es la
  // cola de trabajo del equipo. Un string vacío significaría "no filtrar".
  if (f.ownerId === 'ninguno') where.ownerId = null;
  else if (f.ownerId) where.ownerId = f.ownerId;
  if (f.tagId) where.contact = { tags: { some: { tagId: f.tagId } } };
  const q = f.q?.trim();
  if (q) {
    // El texto va en un `AND`, NO en `where.OR`, y esto no es estilo: `dealScope` mete su
    // propio `OR` (los míos o los de nadie), así que asignar `where.OR` aquí lo
    // SOBRESCRIBIRÍA y un agente que busca vería los tratos de todo el negocio. Es el
    // mismo motivo por el que `buildConversationWhere` cuelga sus extras de un `AND`.
    where.AND = [
      {
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { contact: { name: { contains: q, mode: 'insensitive' } } },
          { contact: { company: { contains: q, mode: 'insensitive' } } },
        ],
      },
    ];
  }
  return where;
}

export function parseDealFilters(query: Record<string, unknown>): DealFilters {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const status = str(query.status);
  return {
    pipelineId: str(query.pipelineId),
    ownerId: str(query.ownerId),
    tagId: str(query.tagId),
    q: str(query.q),
    // 'todos' = sin filtro de estado (para una vista de histórico). Cualquier otra cosa
    // que no sea del enum se ignora en vez de fallar: un filtro mal escrito debe devolver
    // el tablero, no un 400.
    status:
      status === 'todos'
        ? undefined
        : status && (['open', 'won', 'lost'] as string[]).includes(status)
          ? (status as DealStatus)
          : 'open',
  };
}

/**
 * Importe.
 *
 * Se valida como TEXTO y se devuelve como texto para que Prisma lo meta en el `Decimal`
 * sin pasar por un `number`: `0.1 + 0.2` no es dinero.
 *
 * Acepta lo que la gente escribe de verdad —`$3,000.50`, `3.000,50`, `3000`— pero **se
 * niega a adivinar** cuando el separador es ambiguo. `10.999` en notación es-MX son diez
 * mil novecientos noventa y nueve, y en notación inglesa son diez con 999 milésimas; quien
 * lo escribe casi siempre quería `10.99`. Interpretarlo en silencio es un error de 1000×
 * en una columna de dinero, así que se pide que lo desambigüe.
 */
export function parseImporte(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) throw new DealError('El monto no puede ser negativo');
    return v.toFixed(2);
  }
  if (typeof v !== 'string') throw new DealError('El monto debe ser un número');

  // Fuera espacios y símbolo de moneda; quedan dígitos, separadores y el signo.
  const bruto = v.trim().replace(/[^\d.,-]/g, '');
  if (!bruto) throw new DealError('El monto no es un número válido');
  if (bruto.includes('-')) throw new DealError('El monto no puede ser negativo');

  const puntos = (bruto.match(/\./g) ?? []).length;
  const comas = (bruto.match(/,/g) ?? []).length;
  let limpio: string;

  if (puntos && comas) {
    // Los dos presentes: el ÚLTIMO en aparecer es el decimal y el otro son miles.
    const decimal = bruto.lastIndexOf('.') > bruto.lastIndexOf(',') ? '.' : ',';
    const miles = decimal === '.' ? ',' : '.';
    limpio = bruto.split(miles).join('').replace(decimal, '.');
  } else if (puntos > 1 || comas > 1) {
    // Repetido: solo puede ser separador de miles (`1.234.567`).
    limpio = bruto.replace(/[.,]/g, '');
  } else if (puntos === 1 || comas === 1) {
    const sep = puntos ? '.' : ',';
    const [entera, resto] = bruto.split(sep);
    if (resto.length === 3) {
      // AMBIGUO. No se adivina.
      throw new DealError(
        `¿"${v.trim()}" son ${entera}${resto} o ${entera} con decimales? Escríbelo sin separador de miles (${entera}${resto}) o con dos decimales.`,
      );
    }
    limpio = `${entera}.${resto}`;
  } else {
    limpio = bruto;
  }

  if (!/^\d+(\.\d{1,2})?$/.test(limpio)) {
    throw new DealError('El monto no es un número válido (máximo dos decimales)');
  }
  return limpio;
}

const EDITABLES = ['title', 'stageId', 'ownerId', 'expectedCloseAt', 'amount'] as const;

/**
 * Filtra el body de `PATCH /deals/:id`.
 *
 * `status`, `closedAt` y `lostReason` NO están: los pone `parseCierre`, porque cerrar un
 * trato tiene efecto de dominio (escribe su `Activity` y sella la fecha) y dejar que un
 * PATCH genérico toque `status` permitiría un trato `won` con `closedAt` nulo.
 */
export function parseDealPatch(body: unknown): Prisma.DealUncheckedUpdateInput {
  if (!body || typeof body !== 'object') throw new DealError('Cuerpo inválido');
  const src = body as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const k of EDITABLES) {
    if (!(k in src)) continue;
    const v = src[k];
    if (k === 'amount') {
      data.amount = parseImporte(v);
      continue;
    }
    if (k === 'expectedCloseAt') {
      data.expectedCloseAt = parseFecha(v);
      continue;
    }
    if (v === null || v === '') {
      // El título no se puede vaciar: una tarjeta sin nombre no se distingue de otra.
      if (k === 'title') throw new DealError('El título no puede quedar vacío');
      // `stageId` tampoco: un trato siempre está en una etapa.
      if (k === 'stageId') throw new DealError('Campo requerido: stageId');
      data[k] = null;
      continue;
    }
    if (typeof v !== 'string') throw new DealError(`${k} debe ser texto`);
    const t = v.trim();
    if (!t && k === 'title') throw new DealError('El título no puede quedar vacío');
    data[k] = t || null;
  }
  if (!Object.keys(data).length) throw new DealError('Nada que actualizar');
  return data as Prisma.DealUncheckedUpdateInput;
}

function parseFecha(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' && !(v instanceof Date)) throw new DealError('Fecha inválida');
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new DealError('Fecha inválida');
  // A diferencia de una actividad, aquí el FUTURO es lo normal: es cuándo se espera
  // cerrar. Y el pasado también se permite: un trato que se pasó de fecha sigue abierto y
  // hay que poder verlo tal cual.
  return d;
}

export interface Cierre {
  status: DealStatus;
  lostReason: string | null;
  closedAt: Date | null;
}

/**
 * Cierre o reapertura.
 *
 * `lostReason` es OBLIGATORIO al marcar perdido, y es la única validación de este lote que
 * añade fricción a propósito: es el dato más útil del CRM y el que nadie pone si es
 * opcional. "Se fue con la competencia" tres veces seguidas es una decisión de precio
 * esperando a que alguien la lea.
 */
export function parseCierre(body: unknown, ahora: Date): Cierre {
  const src = (body ?? {}) as Record<string, unknown>;
  const status = src.status;
  if (status !== 'open' && status !== 'won' && status !== 'lost') {
    throw new DealError('status debe ser open, won o lost');
  }
  if (status === 'open') {
    // Reabrir borra la fecha y el motivo: si no, un trato reabierto seguiría diciendo por
    // qué se perdió, y las métricas del mes contarían un cierre que ya no existe.
    return { status, lostReason: null, closedAt: null };
  }
  if (status === 'won') return { status, lostReason: null, closedAt: ahora };
  const motivo = typeof src.lostReason === 'string' ? src.lostReason.trim() : '';
  if (!motivo) throw new DealError('Campo requerido: lostReason (por qué se perdió)');
  if (motivo.length > 500) throw new DealError('El motivo no puede pasar de 500 caracteres');
  return { status, lostReason: motivo, closedAt: ahora };
}

// Título por defecto de un trato nuevo. Sale del nombre del contacto porque es lo único
// que se sabe al crearlo, y una tarjeta sin nombre no se distingue de otra en el tablero.
export function tituloPorDefecto(nombre: string | null, waId: string): string {
  const quien = nombre?.trim() || waId.split('@')[0];
  return `Oportunidad · ${quien}`;
}
