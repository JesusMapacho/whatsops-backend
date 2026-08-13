// Atrasada / hoy / próxima NO son una columna: se derivan de `dueAt`. Una columna de
// estado sería una copia que se desincroniza sola al pasar la medianoche — el mismo
// argumento con el que v5-30 derivó las etapas del ciclo de vida.
//
// Este módulo tiene un GEMELO en el frontend (`app/tareas/tareas.buckets.ts`): el de aquí
// decide qué devuelve `?scope=`, el de allá reordena la lista sin ir al servidor cuando
// completas una tarea. Son dos archivos con el mismo criterio y dos checks, no un paquete
// compartido: un paquete común entre backend y frontend es la primera pieza de
// infraestructura que este proyecto todavía no necesita.
// ponytail: la forma de que no se separen es que los DOS checks afirmen los mismos casos
// límite. Si tocas uno, toca el otro.

export type Bucket = 'hecha' | 'atrasada' | 'hoy' | 'proxima';

/**
 * Día natural (YYYY-MM-DD) de un instante EN LA ZONA DEL TENANT.
 *
 * Hace falta y no es un detalle: con la API en UTC y un negocio en `America/Mexico_City`,
 * una tarea de hoy a las 19:00 locales es mañana en UTC, así que un corte hecho con la
 * hora del servidor la manda a «Próximas» a media tarde y el vendedor no la ve.
 *
 * `en-CA` porque su formato numérico corto ya es YYYY-MM-DD; así se comparan como texto y
 * no hace falta aritmética de husos ni una librería de fechas.
 */
export function diaEn(instante: Date, timezone: string | null | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instante);
  } catch {
    // Zona inválida o desconocida por el runtime. Cae a UTC en vez de lanzar: no ver la
    // agenda es peor que verla con un corte de día raro, y el dato viene de la base
    // (capturado en el onboarding), así que no es de fiar por definición.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instante);
  }
}

/**
 * En qué cubo cae una tarea.
 *
 * El corte es por DÍA NATURAL, no por instante: una tarea de hoy a las 09:00 sigue siendo
 * «hoy» a las 18:00. Si se comparara el instante, la lista se iría vaciando hacia
 * «Atrasadas» durante la jornada y la pantalla pasaría de ser un plan a ser un reproche.
 */
export function bucket(
  t: { dueAt: Date; completedAt?: Date | null },
  ahora: Date,
  timezone?: string | null,
): Bucket {
  // Primero, y sin mirar la fecha: una tarea hecha está hecha aunque venciera hace un mes.
  if (t.completedAt) return 'hecha';
  const dia = diaEn(t.dueAt, timezone);
  const hoy = diaEn(ahora, timezone);
  if (dia < hoy) return 'atrasada';
  if (dia === hoy) return 'hoy';
  return 'proxima';
}

// Los cubos que pide la pantalla, en el orden en que se pintan: lo urgente arriba.
export const SCOPES = ['atrasadas', 'hoy', 'proximas', 'hechas', 'todas'] as const;
export type Scope = (typeof SCOPES)[number];

export function parseScope(v: unknown): Scope {
  if (typeof v === 'string' && (SCOPES as readonly string[]).includes(v)) return v as Scope;
  // Por defecto «hoy»: es la pregunta con la que se abre el sistema por la mañana.
  return 'hoy';
}

/**
 * Traduce un scope a los límites de `dueAt` que hay que pedirle a Postgres, en instantes
 * UTC. Se filtra en SQL y no en memoria porque la tabla solo crece y el índice
 * `(tenantId, assignedUserId, completedAt, dueAt)` está puesto justo para esto.
 *
 * `desde` es inclusivo y `hasta` exclusivo — el patrón de siempre con fechas: con `hasta`
 * inclusivo hay que elegir un último milisegundo y siempre se elige mal.
 */
export function rangoDeScope(
  scope: Scope,
  ahora: Date,
  timezone?: string | null,
): { desde?: Date; hasta?: Date; completadas: boolean | null } {
  const inicioDeHoy = inicioDelDia(ahora, timezone);
  const inicioDeManana = new Date(inicioDeHoy.getTime() + 24 * 60 * 60 * 1000);
  switch (scope) {
    case 'atrasadas':
      return { hasta: inicioDeHoy, completadas: false };
    case 'hoy':
      return { desde: inicioDeHoy, hasta: inicioDeManana, completadas: false };
    case 'proximas':
      return { desde: inicioDeManana, completadas: false };
    case 'hechas':
      return { completadas: true };
    default:
      // `null` = no filtrar por completadas, que no es lo mismo que `false`.
      return { completadas: null };
  }
}

/**
 * Instante UTC de la medianoche del día del tenant.
 *
 * Se calcula restando el desplazamiento real de la zona en ese momento, sacado de la
 * diferencia entre el instante formateado como si fuera UTC y el instante de verdad. Con
 * `Intl` esto es exacto también en los cambios de horario de verano, que es donde
 * fallaría un `-6h` a mano.
 */
export function inicioDelDia(ahora: Date, timezone?: string | null): Date {
  const dia = diaEn(ahora, timezone); // YYYY-MM-DD en la zona del tenant
  // Medianoche de ese día interpretada como UTC, y luego corregida por el desplazamiento.
  const medianocheComoUtc = new Date(`${dia}T00:00:00Z`);
  const desplazamiento = desplazamientoMs(medianocheComoUtc, timezone);
  return new Date(medianocheComoUtc.getTime() - desplazamiento);
}

// Desplazamiento de la zona respecto a UTC, en ms, para un instante dado.
function desplazamientoMs(instante: Date, timezone?: string | null): number {
  const partes = (() => {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone || 'UTC',
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).formatToParts(instante);
    } catch {
      return null;
    }
  })();
  if (!partes) return 0;
  const get = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? '00';
  const comoUtc = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute')),
    Number(get('second')),
  );
  return comoUtc - instante.getTime();
}
