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

/**
 * ¿Este mensaje entrante dispara este trigger?
 *
 * Los grupos quedan fuera SIEMPRE, sea cual sea el trigger: una automatización que
 * contesta sola en un grupo de veinte personas es la peor cara posible del producto.
 */
export function disparaConEntrante(raw: unknown, evento: EventoEntrante): boolean {
  if (evento.esGrupo) return false;
  const trigger = leerTrigger(raw);
  switch (trigger.type) {
    case 'message.inbound':
    case 'webhook.received':
      return true;
    case 'message.keyword': {
      const palabras = Array.isArray(trigger.config?.palabras)
        ? (trigger.config!.palabras as unknown[]).filter((p): p is string => typeof p === 'string')
        : [];
      if (!palabras.length) return false;
      const texto = normal(evento.texto);
      // `includes` y no igualdad: la gente escribe «hola, quiero info», no «info».
      return palabras.some((p) => p.trim() !== '' && texto.includes(normal(p)));
    }
    default:
      // `schedule.cron` y `manual` no los dispara un mensaje.
      return false;
  }
}

/** Patrón cron de un trigger `schedule.cron`, o null si no lo es o no lo trae. */
export function patronCron(raw: unknown): string | null {
  const trigger = leerTrigger(raw);
  if (trigger.type !== 'schedule.cron') return null;
  const patron = trigger.config?.patron;
  return typeof patron === 'string' && patron.trim() ? patron.trim() : null;
}
