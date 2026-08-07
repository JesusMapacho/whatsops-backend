// Guardarraíles de la capa gratuita (WAHA). Puro: sin Nest ni DB, los conteos se
// inyectan → testeable en limits.check.ts.
//
// Por qué existe: WAHA es un transporte no oficial y las reglas de WhatsApp se
// aplican al número, no a la API. La guía de WAHA es explícita: nunca iniciar
// conversación, ritmo moderado, y **5-10 marcas de spam banean**. Como hosteamos
// la instancia, un tenant que spamea no solo quema su número: quema el patrón de
// nuestra IP y arrastra a los demás tenants de la misma instancia.
//
// OJO: hasta la feature 29 la regla "nunca inicies conversación" se cumplía
// ESTRUCTURALMENTE, porque las Conversation solo nacían de un inbound. Eso ya NO es
// cierto: ahora se puede escribir primero. El invariante estructural se sustituye por
// topes explícitos de PRIMER CONTACTO (ver isCold y los campos maxCold*), que son la
// única cosa que impide juntar las 5-10 marcas de spam que banean un número.

export interface LimitConfig {
  // Salientes por hora al MISMO contacto. Def. 4, de la guía de WAHA.
  maxPerContactHour: number;
  // Techo diario por tenant, para que un bucle no vacíe la reputación en una noche.
  maxPerDay: number;
  // Conversaciones NUEVAS en frío por hora y por día. Separados por plan porque el
  // techo en frío no se exime pagando, solo se ensancha.
  maxColdPerHour: number;
  maxColdPerDay: number;
  maxColdPerHourPaid: number;
  maxColdPerDayPaid: number;
}

export const DEFAULT_LIMITS: LimitConfig = {
  maxPerContactHour: 4,
  maxPerDay: 200,
  maxColdPerHour: 5,
  maxColdPerDay: 20,
  maxColdPerHourPaid: 30,
  maxColdPerDayPaid: 200,
};

export function limitsFromEnv(get: (k: string) => string | undefined): LimitConfig {
  const num = (k: string, def: number) => Number(get(k)) || def;
  return {
    maxPerContactHour: num('WAHA_MAX_PER_CONTACT_HOUR', DEFAULT_LIMITS.maxPerContactHour),
    maxPerDay: num('WAHA_MAX_PER_DAY', DEFAULT_LIMITS.maxPerDay),
    maxColdPerHour: num('COLD_MAX_PER_HOUR', DEFAULT_LIMITS.maxColdPerHour),
    maxColdPerDay: num('COLD_MAX_PER_DAY', DEFAULT_LIMITS.maxColdPerDay),
    maxColdPerHourPaid: num('COLD_MAX_PER_HOUR_PAID', DEFAULT_LIMITS.maxColdPerHourPaid),
    maxColdPerDayPaid: num('COLD_MAX_PER_DAY_PAID', DEFAULT_LIMITS.maxColdPerDayPaid),
  };
}

// En FRÍO = el interlocutor nunca nos escribió.
//
// NO es lo mismo que "fuera de la ventana de 24 h": quien nos escribió hace tres días
// ya nos conoce y no nos marca como spam por retomar la conversación. Quien nunca
// escribió, sí. Esa distinción es la que justifica dos juegos de topes distintos.
export function isCold(lastInboundAt: Date | null): boolean {
  return lastInboundAt === null;
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export interface LimitCounts {
  // Salientes a este CONTACTO en la última hora, EXCLUYENDO los que el dueño mandó
  // desde su propio teléfono: si contaran, cuatro respuestas rápidas desde el celular
  // dejarían al agente bloqueado con un 429 en la bandeja.
  //
  // Se cuenta por contacto y NO por conversación: el worker crea una Conversation
  // nueva cuando la anterior está cerrada, así que con el conteo por conversación
  // bastaba cerrar el hilo para resetear el tope anti-baneo (bug preexistente).
  contactLastHour: number;
  // Salientes del tenant en las últimas 24 h, incluyendo los del teléfono: consumen
  // la reputación del número igual, y ese es el recurso que protege el cupo diario.
  tenantLastDay: number;
  // Los tres de abajo solo hacen falta cuando `opts.cold` es true, así que son
  // opcionales para no obligar a cada llamada en caliente a pasar ceros. Pero si
  // faltan EN FRÍO, checkLimits lanza: tratarlos como 0 sería permitir en silencio
  // justo en el camino que puede costar el número.

  // Salientes ya enviados en ESTA conversación mientras seguía en frío.
  coldConversationOut?: number;
  // Conversaciones DISTINTAS iniciadas en frío en la última hora / 24 h.
  //
  // Se cuentan conversaciones y no mensajes a propósito: 500 primeros contactos
  // caben de sobra bajo un tope de "500 mensajes al día", y el número que de verdad
  // importa es a cuántos desconocidos molestamos.
  coldTenantHour?: number;
  coldTenantDay?: number;
}

export type LimitVerdict = { allowed: true } | { allowed: false; message: string };

// Decide si se permite UN saliente más. `plan` distinto de 'free' queda exento:
// quien paga usa el transporte oficial y no necesita que lo protejamos de sí mismo.
export function checkLimits(
  counts: LimitCounts,
  cfg: LimitConfig,
  plan: string,
  opts: { isGroup?: boolean; cold?: boolean } = {},
): LimitVerdict {
  // El techo en FRÍO se evalúa ANTES de la exención por plan: pagar no compra el
  // derecho a molestar a desconocidos. Y en Cloud API pasarse no quema el número,
  // quema la CALIDAD de la WABA del propio tenant — y Meta no avisa hasta que ya se
  // la bajó y le recortó el cupo de mensajería.
  if (opts.cold) {
    if (
      counts.coldConversationOut === undefined ||
      counts.coldTenantHour === undefined ||
      counts.coldTenantDay === undefined
    ) {
      // Programación, no entrada del usuario: quien pide un veredicto en frío tiene
      // que traer los conteos en frío. Silenciarlo con 0 sería permitir sin medir.
      throw new Error('checkLimits: faltan los conteos en frío');
    }
    if (opts.isGroup) {
      return { allowed: false, message: 'No se puede iniciar un grupo en frío.' };
    }
    // Un solo mensaje por desconocido, sin ventana de tiempo. Es la regla que de
    // verdad evita juntar las 5-10 marcas de spam que banean un número.
    if (counts.coldConversationOut > 0) {
      return {
        allowed: false,
        message:
          'Ya le escribiste y todavía no ha contestado. Espera su respuesta antes de volver a insistir.',
      };
    }
    const paid = plan !== 'free';
    const perHour = paid ? cfg.maxColdPerHourPaid : cfg.maxColdPerHour;
    const perDay = paid ? cfg.maxColdPerDayPaid : cfg.maxColdPerDay;
    if (counts.coldTenantHour >= perHour) {
      return {
        allowed: false,
        message: `Llegaste al límite de ${perHour} conversaciones nuevas por hora. Inténtalo más tarde.`,
      };
    }
    if (counts.coldTenantDay >= perDay) {
      return {
        allowed: false,
        message: `Llegaste al límite de ${perDay} conversaciones nuevas al día. Se renueva en 24 h.`,
      };
    }
    // El ritmo *en caliente* no aplica a un primer contacto: por definición no hay
    // historial con esta persona.
    return { allowed: true };
  }

  if (plan !== 'free') return { allowed: true };

  // El ritmo por contacto protege de parecer spam ante UNA persona. En un grupo no
  // aplica: 4 mensajes/hora haría inusable cualquier grupo con algo de actividad.
  // El cupo diario sí sigue vigente, que es el que protege la reputación del número.
  if (!opts.isGroup && counts.contactLastHour >= cfg.maxPerContactHour) {
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
