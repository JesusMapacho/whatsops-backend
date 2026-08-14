import { TaskType } from '@prisma/client';
import { componerDueAt, diaEn } from './tasks.buckets';

// Automatismo 2 (v8 feature 38): al caer un trato en una etapa configurada, se crea su tarea
// de seguimiento.
//
// DOS COLUMNAS Y NO UN MOTOR DE REGLAS. `Stage.autoTaskTitle` + `Stage.autoTaskDays` cubren el
// caso real —«al mandar la cotización, recuérdame llamar en dos días»— con cero
// infraestructura. El día que alguien pida condiciones, ramas o varias acciones, eso ES el
// orquestador v3 y no hay que construirlo dos veces.

export type MotivoOmision = 'sin-configurar' | 'sin-dueno';

export type DecisionTareaAuto =
  | { crear: false; motivo: MotivoOmision }
  | { crear: true; title: string; dueAt: Date; assignedUserId: string; type: TaskType };

export interface EtapaConfigurable {
  name: string;
  autoTaskTitle?: string | null;
  autoTaskDays?: number | null;
}

/**
 * Suma días de CALENDARIO al día del tenant y devuelve `YYYY-MM-DD`.
 *
 * De calendario y no sumando milisegundos: el día de un cambio de horario de verano mide 23 o
 * 25 horas, así que `ahora + n * 86400000` puede caer en el día anterior o el siguiente al
 * que se pedía. Aquí se toma el día del tenant, se le suman `n` días como números, y
 * `Date.UTC` normaliza los desbordes de mes y de año sin tocar husos.
 */
export function diaMasN(ahora: Date, dias: number, timezone?: string | null): string {
  const [y, m, d] = diaEn(ahora, timezone).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + dias));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

/**
 * ¿Hay que crear una tarea al caer en esta etapa, y cuál?
 *
 * Pura y separada del servicio para poder comprobar los dos motivos de omisión, que son la
 * parte que se puede leer mal: una etapa sin configurar y un trato sin dueño no son lo mismo,
 * y el segundo hay que **contarlo** en el timeline para que no parezca un fallo silencioso.
 *
 * `dueAt` son las **09:00 del día del tenant** a `autoTaskDays` días. Días **naturales**, sin
 * calendario laboral.
 * ponytail: una tarea que cae en domingo se ve el lunes en Atrasadas, que es tolerable. Un
 * calendario laboral por tenant (con festivos por país) no toca todavía; cuando toque, es aquí.
 */
export function decidirTareaAuto(opciones: {
  stage: EtapaConfigurable;
  dealOwnerId: string | null;
  dealTitle: string;
  ahora: Date;
  timezone?: string | null;
}): DecisionTareaAuto {
  const { stage, dealOwnerId, ahora, timezone } = opciones;
  const title = stage.autoTaskTitle?.trim();
  // Los dos campos o ninguno: un título sin plazo no dice cuándo y un plazo sin título no dice
  // qué. El servicio del embudo ya lo valida al guardar (feature 36), y aquí se vuelve a mirar
  // porque una fila vieja o tocada a mano en la base puede tener medio configurado.
  if (!title || stage.autoTaskDays === null || stage.autoTaskDays === undefined) {
    return { crear: false, motivo: 'sin-configurar' };
  }
  // Sin dueño no se crea: `Task.assignedUserId` no es nulable porque una tarea de nadie no la
  // hace nadie (feature 37). Es el caso de los tratos que crea el alta automática, que nacen
  // sin responsable a propósito.
  if (!dealOwnerId) return { crear: false, motivo: 'sin-dueno' };

  const dias = Math.max(0, Math.trunc(stage.autoTaskDays));
  return {
    crear: true,
    title,
    dueAt: componerDueAt(diaMasN(ahora, dias, timezone), null, timezone),
    assignedUserId: dealOwnerId,
    // Llamada por defecto, igual que el alta a mano: es el seguimiento más común y el tipo se
    // puede cambiar después. Configurar el tipo por etapa sería una tercera columna para una
    // preferencia que casi nadie ajusta.
    type: 'call',
  };
}

/**
 * Lo que se anota en el `data` del `Activity` del cambio de etapa.
 *
 * `undefined` cuando la etapa no tiene nada configurado: si se escribiera
 * `tareaAuto: 'sin-configurar'` en cada movimiento, el timeline se llenaría de ruido sobre algo
 * que nadie pidió.
 */
export function anotacionDe(d: DecisionTareaAuto): 'creada' | 'sin-dueno' | undefined {
  if (d.crear) return 'creada';
  return d.motivo === 'sin-dueno' ? 'sin-dueno' : undefined;
}
