import { Prisma, TaskType } from '@prisma/client';
import { componerDueAt } from './tasks.buckets';

// Tope de la lista, con el mismo criterio que `INBOX_TAKE` y `DEALS_TAKE`.
// ponytail: sin paginación. Una agenda con más de 200 tareas pendientes ya no se lee; el
// camino de upgrade es filtrar por tipo o por rango, no paginar.
export const TASKS_TAKE = 200;

export const TIPOS: TaskType[] = ['call', 'whatsapp', 'email', 'meeting', 'other'];

const MAX_TITULO = 200;
const MAX_OUTCOME = 2000;

export class TaskError extends Error {}

export interface TaskNueva {
  title: string;
  type: TaskType;
  dueAt: Date;
  assignedUserId?: string;
  contactId?: string;
  dealId?: string;
}

/**
 * Cuerpo de `POST /tasks`.
 *
 * La fecha entra como **día + hora opcional**, no como un ISO ya compuesto: el día es lo que
 * significa algo («llamar el jueves») y la hora es la excepción. Componerlo en el servidor
 * mantiene la zona del tenant donde vive la zona del tenant, y el cliente no tiene que saber
 * de husos para crear una tarea.
 */
export function parseTaskNueva(body: unknown, timezone?: string | null): TaskNueva {
  if (!body || typeof body !== 'object') throw new TaskError('Cuerpo inválido');
  const src = body as Record<string, unknown>;

  const title = texto(src.title, 'title', MAX_TITULO);
  const type = parseTipo(src.type);
  const dueAt = parseVencimiento(src, timezone);

  const opt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    title,
    type,
    dueAt,
    assignedUserId: opt(src.assignedUserId),
    contactId: opt(src.contactId),
    dealId: opt(src.dealId),
  };
}

/**
 * Cuerpo de `PATCH /tasks/:id`: reprogramar, reasignar, renombrar, cambiar el tipo.
 *
 * `completedAt` y `outcome` NO están: cerrar una tarea tiene efecto de dominio (escribe su
 * `Activity`), así que va por su propia ruta. Por aquí se podría dejar una tarea con
 * `completedAt` puesto y sin registro en el timeline, que es la desincronización que el
 * modelo evita al no tener columna de estado.
 */
export function parseTaskPatch(body: unknown, timezone?: string | null): Prisma.TaskUncheckedUpdateInput {
  if (!body || typeof body !== 'object') throw new TaskError('Cuerpo inválido');
  const src = body as Record<string, unknown>;
  const data: Record<string, unknown> = {};

  if ('title' in src) data.title = texto(src.title, 'title', MAX_TITULO);
  if ('type' in src) data.type = parseTipo(src.type);
  // Reprogramar: se manda el día (y la hora si la hay), igual que al crear.
  if ('dueDate' in src) data.dueAt = parseVencimiento(src, timezone);
  if ('assignedUserId' in src) {
    const v = src.assignedUserId;
    // NO nulable: una tarea de nadie no la hace nadie. Reasignar exige a quién.
    if (typeof v !== 'string' || !v.trim()) throw new TaskError('Campo requerido: assignedUserId');
    data.assignedUserId = v.trim();
  }

  if (!Object.keys(data).length) throw new TaskError('Nada que actualizar');
  return data as Prisma.TaskUncheckedUpdateInput;
}

/**
 * Cuerpo de `POST /tasks/:id/complete`.
 *
 * `outcome` es opcional: que la tarea se hizo ya es información, y exigir un texto haría que
 * la gente dejara tareas abiertas para no escribirlo. La UI sí lo pide, porque «¿qué pasó?»
 * en el momento de cerrar es cuando se tiene la respuesta en la cabeza.
 */
export function parseComplete(body: unknown): { outcome: string | null } {
  const v = (body as Record<string, unknown>)?.outcome;
  if (v === undefined || v === null || v === '') return { outcome: null };
  if (typeof v !== 'string') throw new TaskError('outcome debe ser texto');
  const t = v.trim();
  if (t.length > MAX_OUTCOME) throw new TaskError(`outcome no puede pasar de ${MAX_OUTCOME} caracteres`);
  return { outcome: t || null };
}

export interface TaskFilters {
  assignedUserId?: string;
  dealId?: string;
  contactId?: string;
  type?: TaskType;
  /** `true` = ver las de todo el equipo (exige `deals:manage`, lo comprueba el controlador). */
  equipo: boolean;
}

export function parseTaskFilters(query: Record<string, unknown>): TaskFilters {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const type = str(query.type);
  return {
    assignedUserId: str(query.assignedUserId),
    dealId: str(query.dealId),
    contactId: str(query.contactId),
    type: type && (TIPOS as string[]).includes(type) ? (type as TaskType) : undefined,
    equipo: query.equipo === 'true' || query.equipo === true,
  };
}

/**
 * Where de la lista. El rango de `dueAt` y el filtro de completadas los pone el llamador
 * desde `rangoDeScope`; aquí van el tenant, el alcance y los filtros de la pantalla.
 *
 * **Los filtros van en `AND`, nunca asignados sobre el where.** El alcance llega por spread,
 * y para un agente es `{ assignedUserId: <él> }`: asignar `where.assignedUserId` con el valor
 * del query lo SOBRESCRIBIRÍA, y `?assignedUserId=<otro>` sería una puerta a la agenda del
 * resto del equipo. Con `AND`, las dos condiciones conviven y pedir la de otro devuelve vacío.
 *
 * Es el mismo fallo que ya tuvo `buildDealWhere` con su `OR`, y por eso los demás filtros van
 * igual aunque hoy no choquen con el alcance: así un cambio futuro en `taskScope` no vuelve a
 * abrir el agujero.
 */
export function buildTaskWhere(
  tenantId: string,
  f: TaskFilters,
  alcance: Prisma.TaskWhereInput,
): Prisma.TaskWhereInput {
  const where: Prisma.TaskWhereInput = { tenantId, ...alcance };
  const extra: Prisma.TaskWhereInput[] = [];
  if (f.assignedUserId) extra.push({ assignedUserId: f.assignedUserId });
  if (f.dealId) extra.push({ dealId: f.dealId });
  if (f.contactId) extra.push({ contactId: f.contactId });
  if (f.type) extra.push({ type: f.type });
  if (extra.length) where.AND = extra;
  return where;
}

// --- privados ---

function texto(v: unknown, campo: string, max: number): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t) throw new TaskError(`Campo requerido: ${campo}`);
  if (t.length > max) throw new TaskError(`${campo} no puede pasar de ${max} caracteres`);
  return t;
}

function parseTipo(v: unknown): TaskType {
  if (v === undefined || v === null || v === '') return 'call';
  if (typeof v !== 'string' || !(TIPOS as string[]).includes(v)) {
    throw new TaskError(`type debe ser uno de: ${TIPOS.join(', ')}`);
  }
  return v as TaskType;
}

function parseVencimiento(src: Record<string, unknown>, timezone?: string | null): Date {
  const fecha = src.dueDate;
  // Obligatorio: una tarea sin fecha no aparece en ninguna lista y por lo tanto no existe.
  // Si no se sabe cuándo, se pone mañana — pero eso lo decide quien la crea, no el servidor.
  if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    throw new TaskError('Campo requerido: dueDate (YYYY-MM-DD)');
  }
  const hora = typeof src.dueTime === 'string' ? src.dueTime : null;
  if (hora && !/^\d{2}:\d{2}$/.test(hora)) throw new TaskError('dueTime debe ser HH:MM');
  try {
    return componerDueAt(fecha, hora, timezone);
  } catch (e) {
    throw new TaskError((e as Error).message);
  }
}
