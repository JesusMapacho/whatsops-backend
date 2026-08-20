// Qué dispara una automatización (v3 feature 18). Puro (ver triggers.check.ts).
//
// Se evalúa dentro del worker del webhook, una vez por mensaje entrante y por cada
// automatización activa del tenant: tiene que ser barato y no tocar la base.

export const TRIGGERS = [
  'message.inbound',
  'message.keyword',
  'webhook.received',
  'schedule.cron',
  'manual',
] as const;
export type TriggerType = (typeof TRIGGERS)[number];

export interface Trigger {
  type: string;
  config?: Record<string, unknown>;
}

export interface EventoEntrante {
  texto: string;
  // Un grupo no es un cliente (mismo corte que `crm/auto-deal.ts` y la cartera de sistema).
  esGrupo: boolean;
}

function normal(v: string): string {
  return v
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim();
}

/** Lee el trigger guardado como Json sin confiar en su forma. */
export function leerTrigger(raw: unknown): Trigger {
  const t = (raw ?? {}) as Record<string, unknown>;
  return {
    type: typeof t.type === 'string' ? t.type : '',
    config: (t.config ?? {}) as Record<string, unknown>,
  };
}

export interface Disparo {
  dispara: boolean;
  /** La palabra que hizo match, para `message.keyword`. `null` en el resto. */
  palabra: string | null;
}

const NO: Disparo = { dispara: false, palabra: null };

/**
 * ¿Este mensaje entrante dispara este trigger, y con qué palabra?
 *
 * Devuelve la palabra y no solo un booleano porque `normal()` —la normalización de acentos
 * y mayúsculas— es privada de este módulo: si el dato se tira aquí, un nodo posterior que
 * quiera saber cuál coincidió tiene que reimplementar el match, y dos implementaciones del
 * mismo match acaban discrepando. Va al contexto como `disparador.palabra`.
 *
 * Los grupos quedan fuera SIEMPRE, sea cual sea el trigger: una automatización que
 * contesta sola en un grupo de veinte personas es la peor cara posible del producto.
 */
export function evaluarEntrante(raw: unknown, evento: EventoEntrante): Disparo {
  if (evento.esGrupo) return NO;
  const trigger = leerTrigger(raw);
  switch (trigger.type) {
    case 'message.inbound':
      return { dispara: true, palabra: null };
    case 'message.keyword': {
      const palabras = Array.isArray(trigger.config?.palabras)
        ? (trigger.config!.palabras as unknown[]).filter((p): p is string => typeof p === 'string')
        : [];
      if (!palabras.length) return NO;
      const texto = normal(evento.texto);
      // `includes` y no igualdad: la gente escribe «hola, quiero info», no «info».
      const cual = palabras.find((p) => p.trim() !== '' && texto.includes(normal(p)));
      return cual === undefined ? NO : { dispara: true, palabra: cual };
    }
    default:
      // `schedule.cron` y `manual` no los dispara un mensaje. `webhook.received` TAMPOCO
      // desde aquí: tiene su propia URL pública (`hooks.controller.ts`) y ya no es —como
      // era— un duplicado de `message.inbound` que además no traía el evento.
      return NO;
  }
}

/** Patrón cron de un trigger `schedule.cron`, o null si no lo es o no lo trae. */
export function patronCron(raw: unknown): string | null {
  const trigger = leerTrigger(raw);
  if (trigger.type !== 'schedule.cron') return null;
  const patron = trigger.config?.patron;
  return typeof patron === 'string' && patron.trim() ? patron.trim() : null;
}
