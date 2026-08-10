// Ciclo de vida de un contacto al que ESCRIBIMOS NOSOTROS primero. Puro (ver
// lifecycle.check.ts), con la forma de `broadcast.ts` y `waha.reconcile.ts`: toda la
// decisión en una tabla verificable y el servicio limitado a ejecutarla.
//
// Es el modelo de Meta trasladado a la capa gratuita, que no tiene ni ventana ni
// plantillas propias: prospectas → si contesta se abre una ventana de 24 h de charla
// libre → si se cierra, un mensaje de reactivación y a esperar.
//
// SUSTITUYE al freno anterior de "un solo mensaje por desconocido, PARA SIEMPRE". Ese
// era seguro pero inutilizaba la prospección. Lo que impide que el cambio sea una
// barra libre es el tope de intentos: sin él, "uno cada semana indefinidamente" es
// acoso, y es exactamente lo que junta las 5-10 marcas de spam que banean un número.
//
// NO se guarda ningún estado en DB: las cuatro etapas se DERIVAN de datos que ya
// existen (`Conversation.lastInboundAt` y los salientes de la conversación). Una
// columna de estado es una copia que se desincroniza en la primera carrera.

export type Stage =
  // Nunca nos ha contestado y todavía se le puede escribir.
  | 'pendiente'
  // Nunca nos ha contestado y toca esperar el enfriamiento.
  | 'enfriando'
  // Nunca nos ha contestado y se agotaron los intentos. No se le escribe más, nunca.
  | 'agotada'
  // Contestó y la ventana de 24 h está abierta: charla libre.
  | 'activa'
  // Contestó alguna vez, pero la ventana se cerró: solo un mensaje de reactivación.
  | 'reactivable'
  // Se mandó la reactivación y toca esperar antes de volver a intentarlo.
  | 'reactivada-enfriando';

export interface LifecycleConfig {
  // Espera entre intentos, en horas. 7 días por defecto.
  cooldownHours: number;
  // Intentos TOTALES en frío antes de darse por vencido. El primer mensaje cuenta.
  maxColdAttempts: number;
  // Ventana de charla libre tras una respuesta, en horas. La de Meta.
  windowHours: number;
}

export const DEFAULT_LIFECYCLE: LifecycleConfig = {
  cooldownHours: 7 * 24,
  maxColdAttempts: 2,
  windowHours: 24,
};

export function lifecycleFromEnv(get: (k: string) => string | undefined): LifecycleConfig {
  const num = (k: string, def: number) => Number(get(k)) || def;
  return {
    cooldownHours: num('COLD_COOLDOWN_HOURS', DEFAULT_LIFECYCLE.cooldownHours),
    maxColdAttempts: num('COLD_MAX_ATTEMPTS', DEFAULT_LIFECYCLE.maxColdAttempts),
    windowHours: num('COLD_WINDOW_HOURS', DEFAULT_LIFECYCLE.windowHours),
  };
}

export interface LifecycleInput {
  // null = nunca nos ha escrito. Es el `isCold()` de limits.ts.
  lastInboundAt: Date | null;
  // Salientes de la conversación. En la fase en frío son los INTENTOS gastados.
  outCount: number;
  // Fecha del último saliente. Es el reloj del enfriamiento: cuenta desde el último
  // mensaje que mandamos, NO desde que se creó la conversación. Si contara desde la
  // creación, un contacto viejo permitiría insistir de inmediato.
  lastOutAt: Date | null;
  now: Date;
}

const HOUR = 60 * 60 * 1000;

export function contactStage(input: LifecycleInput, cfg: LifecycleConfig): Stage {
  const { lastInboundAt, outCount, lastOutAt, now } = input;
  const enfriado = (since: Date | null) =>
    !since || now.getTime() - since.getTime() >= cfg.cooldownHours * HOUR;

  // --- Nunca ha contestado: prospección con intentos contados ---
  if (lastInboundAt === null) {
    if (outCount >= cfg.maxColdAttempts) return 'agotada';
    if (outCount === 0) return 'pendiente';
    return enfriado(lastOutAt) ? 'pendiente' : 'enfriando';
  }

  // --- Ya contestó: ventana de 24 h ---
  if (now.getTime() - lastInboundAt.getTime() < cfg.windowHours * HOUR) return 'activa';

  // Ventana cerrada. Si el último saliente es POSTERIOR a su respuesta, ya se mandó la
  // reactivación y toca esperar. Si no, queda una por mandar.
  //
  // Aquí NO se aplica el tope de intentos: quien contestó alguna vez dio su
  // consentimiento, y cerrarle la puerta para siempre dejaría sin poder hablar a un
  // cliente que ya compró. El tope es de la prospección, no de la relación.
  const reactivacionYaMandada = !!lastOutAt && lastOutAt > lastInboundAt;
  if (!reactivacionYaMandada) return 'reactivable';
  return enfriado(lastOutAt) ? 'reactivable' : 'reactivada-enfriando';
}

export type SendVerdict = { ok: true } | { ok: false; stage: Stage; message: string };

// ¿Se puede mandar UN mensaje más? El mensaje de error es para el operador y dice
// SIEMPRE qué hacer o cuándo: "bloqueado" sin fecha es una pared.
export function canSend(input: LifecycleInput, cfg: LifecycleConfig): SendVerdict {
  const stage = contactStage(input, cfg);
  if (stage === 'pendiente' || stage === 'activa' || stage === 'reactivable') return { ok: true };

  if (stage === 'agotada') {
    return {
      ok: false,
      stage,
      message:
        `Ya le escribiste ${cfg.maxColdAttempts} veces y no ha contestado. ` +
        'No se le puede escribir más: insistir es lo que hace que WhatsApp bloquee tu número.',
    };
  }
  const desde = input.lastOutAt ?? input.now;
  const cuando = new Date(desde.getTime() + cfg.cooldownHours * HOUR);
  return {
    ok: false,
    stage,
    message:
      `Todavía no ha contestado. Podrás volver a escribirle a partir del ${fecha(cuando)}.`,
  };
}

// Fecha corta y legible en español, sin dependencias.
function fecha(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}/${mm} ${hh}:${mi} UTC`;
}

// ¿Este contacto se puede usar en un envío masivo o en un estado? Es la misma tabla:
// un destinatario en enfriamiento o agotado se SALTA, no rompe el envío.
export function isSendable(input: LifecycleInput, cfg: LifecycleConfig): boolean {
  return canSend(input, cfg).ok;
}
