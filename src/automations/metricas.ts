// Los números de la lista de automatizaciones: el sparkline, la tasa de éxito y cuándo corrió
// cada flujo por última vez.
//
// Puro: ver metricas.check.ts. Lo que toca base vive en `automations.service.ts`, porque los
// checks no levantan Postgres y la aritmética de días es justo lo que hay que poder probar.
//
// La zona horaria NO se reimplementa aquí: `crm/tasks.buckets.ts` ya la resuelve —y ya sabe
// que un día puede durar 23 o 25 horas—, así que este módulo la importa. Un tercer sitio con
// la misma aritmética de husos es cómo se acaba cortando el día de dos maneras distintas
// dentro del mismo producto.
import { diaEn, inicioDelDia } from '../crm/tasks.buckets';

/** Lo que pide la lista si no dice nada: una semana. */
export const DIAS_DEF = 7;
/** El techo. Más allá el sparkline no se lee y la consulta empieza a costar. */
export const DIAS_MAX = 30;

export interface Flujo {
  automationId: string;
  /** Ejecuciones por día, del más antiguo al más reciente. Longitud == `dias`. */
  serie: number[];
  ok: number;
  fallidas: number;
  cortadas: number;
  /** ISO del run más reciente DE SIEMPRE, o `null` si nunca corrió. */
  ultimaEjecucion: string | null;
}

/** Una fila del agregado: un flujo, un día natural, un estado, cuántas veces. */
export interface FilaCubo {
  automationId: string;
  dia: string; // YYYY-MM-DD en la zona del negocio
  status: string;
  n: number;
}

/**
 * `?dias=`. Fuera de rango se **acota**, no se rechaza.
 *
 * Un 400 aquí no le sirve a nadie: la pantalla manda un número de un desplegable suyo, así que
 * un valor raro es un bug del cliente o alguien probando la URL a mano, y en los dos casos
 * enseñar siete días es mejor respuesta que un error. Mismo trato que `?limit=` en `runs()`.
 */
export function parseDias(v: unknown): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n <= 0) return DIAS_DEF;
  return Math.min(n, DIAS_MAX);
}

/**
 * La zona del negocio, o `'UTC'` si el runtime no la reconoce.
 *
 * Existe porque los dos lados del cálculo la tratan distinto: `diaEn` cae a UTC sola ante una
 * zona inválida, pero un `AT TIME ZONE` de Postgres con la misma basura **lanza**. Validarla
 * una vez y pasar el mismo valor a los dos es lo que impide que los cubos los corte Postgres
 * con una zona y las claves las genere el proceso con otra — que sería una serie desalineada
 * en vez de un error visible.
 */
export function zonaValida(timezone: string | null | undefined): string {
  if (!timezone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(0));
    return timezone;
  } catch {
    return 'UTC';
  }
}

/**
 * Los días naturales de la ventana EN LA ZONA DEL NEGOCIO, del más antiguo al más reciente,
 * más la medianoche del primero como instante UTC para el `WHERE`.
 *
 * Días naturales y no ventanas de 24 h hacia atrás: «las ejecuciones de hoy» tiene que querer
 * decir hoy. Con ventanas móviles, la primera barra del sparkline cambiaría de significado
 * cada vez que alguien recarga.
 *
 * Se retrocede **re-anclando** y no restando 24 h, por lo mismo que
 * `tasks.buckets.ts:91-98`: el día del cambio de horario de verano dura 23 o 25 horas, así
 * que restar un día fijo desvía el corte una hora y acaba duplicando o saltándose una fecha.
 * Doce horas hacia atrás desde una medianoche caen siempre dentro del día anterior, con
 * cualquier transición, y a ese instante se le vuelve a pedir su medianoche.
 */
export function ventana(
  ahora: Date,
  dias: number,
  timezone: string | null | undefined,
): { claves: string[]; desde: Date } {
  const claves: string[] = [];
  let cursor = inicioDelDia(ahora, timezone);
  for (let i = 0; i < dias; i++) {
    claves.unshift(diaEn(cursor, timezone));
    if (i < dias - 1) {
      cursor = inicioDelDia(new Date(cursor.getTime() - 12 * 60 * 60 * 1000), timezone);
    }
  }
  // `cursor` quedó en la medianoche del día más antiguo, que es el borde inferior del `WHERE`.
  return { claves, desde: cursor };
}

/**
 * Las filas agregadas → los `flujos` de la respuesta.
 *
 * Tres cosas que la pantalla da por hechas y que se deciden aquí:
 *
 * 1. **Sale un flujo por cada automatización del tenant**, haya corrido o no. La que nunca
 *    corrió sale con la serie a ceros y `ultimaEjecucion: null`. Si faltara la fila, el
 *    frontend tendría que distinguir «no corrió» de «no llegó el dato», y ésa es exactamente
 *    la mentira que su `core/carga.ts` existe para evitar.
 * 2. **`running` y `waiting` cuentan en `serie` pero no en los contadores.** Son ejecuciones
 *    que pasaron —van en el sparkline— pero todavía no son ni un éxito ni un fallo, así que
 *    meterlas en la tasa la haría bajar sola mientras un flujo trabaja. La consecuencia es que
 *    `sum(serie)` puede ser MAYOR que `ok + fallidas + cortadas`, y eso es correcto: la
 *    diferencia son los runs en vuelo.
 * 3. **Un estado que no reconoce cuenta en `serie` y en ninguna otra parte, sin lanzar.**
 *    `AutomationRunStatus` es un enum de Postgres y añadirle un valor no puede tumbar la
 *    pantalla entera. Mismo criterio que el barrido con los estados que no conoce.
 *
 * `automationIds` manda sobre `filas`: una fila cuyo flujo no esté en la lista se descarta. Es
 * el último filo del alcance por tenant en esta capa — la lista viene ya acotada por
 * `tenantId`, así que descartar y no inventar es lo que impide que un flujo ajeno se cuele si
 * alguna vez la consulta de arriba se escribe mal.
 */
export function armar(
  automationIds: string[],
  filas: FilaCubo[],
  claves: string[],
  ultimas: Map<string, Date>,
): Flujo[] {
  const indice = new Map(claves.map((c, i) => [c, i]));
  const flujos = new Map<string, Flujo>();
  for (const id of automationIds) {
    flujos.set(id, {
      automationId: id,
      serie: new Array(claves.length).fill(0),
      ok: 0,
      fallidas: 0,
      cortadas: 0,
      ultimaEjecucion: ultimas.get(id)?.toISOString() ?? null,
    });
  }

  for (const f of filas) {
    const flujo = flujos.get(f.automationId);
    if (!flujo) continue; // no es de este tenant, o es de un flujo recién borrado
    const i = indice.get(f.dia);
    if (i === undefined) continue; // fuera de la ventana; no debería llegar, pero no se suma
    const n = Number(f.n) || 0;
    flujo.serie[i] += n;
    if (f.status === 'done') flujo.ok += n;
    else if (f.status === 'failed') flujo.fallidas += n;
    else if (f.status === 'cortado') flujo.cortadas += n;
  }

  return [...flujos.values()];
}
