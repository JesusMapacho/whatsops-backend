// Guardarraíles de la capa gratuita (WAHA). Puro: sin Nest ni DB, los conteos se
// inyectan → testeable en limits.check.ts.
//
// Por qué existe: WAHA es un transporte no oficial y las reglas de WhatsApp se
// aplican al número, no a la API. La guía de WAHA es explícita: nunca iniciar
// conversación, ritmo moderado, y **5-10 marcas de spam banean**. Como hosteamos
// la instancia, un tenant que spamea no solo quema su número: quema el patrón de
// nuestra IP y arrastra a los demás tenants de la misma instancia.
//
// La regla "nunca inicies conversación" ya se cumple estructuralmente: las
// Conversation solo nacen de un inbound y no hay UI de conversación nueva. Lo que
// falta —y esto lo cubre— es el RITMO.

export interface LimitConfig {
  // Salientes por hora al MISMO contacto. Def. 4, de la guía de WAHA.
  maxPerContactHour: number;
  // Techo diario por tenant, para que un bucle no vacíe la reputación en una noche.
  maxPerDay: number;
}

export const DEFAULT_LIMITS: LimitConfig = {
  maxPerContactHour: 4,
  maxPerDay: 200,
};

export function limitsFromEnv(get: (k: string) => string | undefined): LimitConfig {
  return {
    maxPerContactHour:
      Number(get('WAHA_MAX_PER_CONTACT_HOUR')) || DEFAULT_LIMITS.maxPerContactHour,
    maxPerDay: Number(get('WAHA_MAX_PER_DAY')) || DEFAULT_LIMITS.maxPerDay,
  };
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export interface LimitCounts {
  // Salientes a este contacto en la última hora, EXCLUYENDO los que el dueño
  // mandó desde su propio teléfono: si contaran, cuatro respuestas rápidas desde
  // el celular dejarían al agente bloqueado con un 429 en la bandeja.
  contactLastHour: number;
  // Salientes del tenant en las últimas 24 h, incluyendo los del teléfono:
  // consumen la reputación del número igual, y ese es el recurso que protege el
  // cupo diario.
  tenantLastDay: number;
}

export type LimitVerdict = { allowed: true } | { allowed: false; message: string };

// Decide si se permite UN saliente más. `plan` distinto de 'free' queda exento:
// quien paga usa el transporte oficial y no necesita que lo protejamos de sí mismo.
export function checkLimits(
  counts: LimitCounts,
  cfg: LimitConfig,
  plan: string,
): LimitVerdict {
  if (plan !== 'free') return { allowed: true };

  if (counts.contactLastHour >= cfg.maxPerContactHour) {
    return {
      allowed: false,
      message:
        `Límite de ${cfg.maxPerContactHour} mensajes por hora a un mismo contacto. ` +
        'Es para que WhatsApp no bloquee tu número: espera un momento o pásate a un plan con la API oficial.',
    };
  }
  if (counts.tenantLastDay >= cfg.maxPerDay) {
    return {
      allowed: false,
      message:
        `Alcanzaste el cupo diario de ${cfg.maxPerDay} mensajes de la capa gratuita. ` +
        'Se renueva en 24 h, o puedes pasar a un plan con la API oficial de WhatsApp.',
    };
  }
  return { allowed: true };
}
