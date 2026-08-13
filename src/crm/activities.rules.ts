import { ActivityType } from '@prisma/client';

/**
 * Los ÚNICOS tipos que una persona puede registrar por `POST /activities`.
 *
 * Allowlist en código, con el mismo criterio que `MUTATION_TOOLS` del asistente. El resto
 * de la enumeración —`stage_change`, `deal_created`, `deal_won`, `deal_lost`,
 * `task_done`— la escribe el servidor cuando esos hechos pasan de verdad: si un cliente
 * pudiera inyectarlos, el timeline dejaría de ser un registro y pasaría a ser un cuento,
 * y las métricas comerciales se calculan sobre él.
 */
export const TIPOS_MANUALES: ActivityType[] = ['note', 'call', 'meeting'];

// Tope del cuerpo. Una nota es una nota; sin tope, este campo es un sitio donde pegar un
// megabyte por accidente y arrastrarlo en cada carga del timeline.
export const MAX_BODY = 5000;

// Página del timeline. Se pagina por CURSOR sobre `occurredAt` y no por `skip`: es una
// tabla que solo crece, y el índice `(tenantId, contactId, occurredAt)` está puesto justo
// para esto.
export const TIMELINE_TAKE = 50;

export class ActivityError extends Error {}

export interface ActividadManual {
  type: ActivityType;
  body?: string;
  occurredAt: Date;
}

/**
 * Valida el body de `POST /activities`.
 *
 * `occurredAt` lo manda el cliente porque una llamada se registra DESPUÉS de ocurrir —
 * ese es el motivo de que la columna exista aparte de `createdAt`. Pero se rechaza si
 * viene del futuro: registrar una reunión que todavía no ha pasado es una TAREA, y la
 * pantalla la ofrece así. Sin este freno, el timeline mezcla historial con planes y deja
 * de servir para ninguna de las dos cosas.
 */
export function parseActividadManual(body: unknown, ahora: Date): ActividadManual {
  if (!body || typeof body !== 'object') throw new ActivityError('Cuerpo inválido');
  const src = body as Record<string, unknown>;

  const type = src.type;
  if (typeof type !== 'string' || !(TIPOS_MANUALES as string[]).includes(type)) {
    throw new ActivityError(`type debe ser uno de: ${TIPOS_MANUALES.join(', ')}`);
  }

  let texto: string | undefined;
  if (src.body !== undefined && src.body !== null && src.body !== '') {
    if (typeof src.body !== 'string') throw new ActivityError('body debe ser texto');
    texto = src.body.trim();
    if (texto.length > MAX_BODY) {
      throw new ActivityError(`body no puede pasar de ${MAX_BODY} caracteres`);
    }
    if (!texto) texto = undefined;
  }
  // Una NOTA sin texto no es nada; una llamada sin texto sí (que se llamó ya es
  // información, igual que completar una tarea sin resultado).
  if (type === 'note' && !texto) throw new ActivityError('Campo requerido: body');

  const occurredAt = parseFecha(src.occurredAt, ahora);
  return { type: type as ActivityType, body: texto, occurredAt };
}

function parseFecha(v: unknown, ahora: Date): Date {
  if (v === undefined || v === null || v === '') return ahora;
  if (typeof v !== 'string' && !(v instanceof Date)) {
    throw new ActivityError('occurredAt debe ser una fecha ISO');
  }
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new ActivityError('occurredAt no es una fecha válida');
  // Un minuto de margen: los relojes del navegador y del servidor no van al milisegundo, y
  // "ahora" enviado por la UI llegaría un instante en el futuro.
  if (d.getTime() > ahora.getTime() + 60_000) {
    throw new ActivityError(
      'occurredAt no puede estar en el futuro; lo que aún no ha pasado es una tarea, no una actividad',
    );
  }
  return d;
}

// Cursor del timeline: el `occurredAt` de la última fila pintada. Formato ISO, y si viene
// basura se ignora en vez de fallar — una página mal pedida debe devolver la primera, no
// romper la pantalla.
export function parseCursor(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
