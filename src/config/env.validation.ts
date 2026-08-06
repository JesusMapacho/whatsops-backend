// ponytail: validación de env a mano, sin Joi/class-validator. Falla rápido si falta algo.
const REQUIRED = ['DATABASE_URL', 'REDIS_URL', 'PORT', 'JWT_SECRET', 'ENCRYPTION_KEY', 'WEBHOOK_VERIFY_TOKEN', 'META_APP_SECRET'] as const;

// El asistente (v1.5) es opcional: la app arranca sin él. Pero si se configura
// (aparece LLM_MODEL), exigimos el grupo completo para no arrancar a medias.
const ASSISTANT_GROUP = ['LLM_MODEL', 'LLM_API_KEY'] as const;

// Igual con WAHA (v5): la capa gratuita es opcional, pero media configuración es
// peor que ninguna — fallaría en el request, con la sesión ya creada o el webhook
// llegando sin secreto con el que verificarlo.
const WAHA_GROUP = [
  'WAHA_URL',
  'WAHA_API_KEY',
  'WAHA_CALLBACK_URL',
  'WAHA_WEBHOOK_SECRET',
] as const;

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const missing = REQUIRED.filter((k) => !config[k]);
  if (missing.length) {
    throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);
  }
  const assistantOn = ASSISTANT_GROUP.some((k) => config[k]);
  if (assistantOn) {
    const gaps = ASSISTANT_GROUP.filter((k) => !config[k]);
    if (gaps.length) {
      throw new Error(`Asistente mal configurado, faltan: ${gaps.join(', ')}`);
    }
  }
  const wahaOn = WAHA_GROUP.some((k) => config[k]);
  if (wahaOn) {
    const gaps = WAHA_GROUP.filter((k) => !config[k]);
    if (gaps.length) {
      throw new Error(`WAHA mal configurado, faltan: ${gaps.join(', ')}`);
    }
  }
  return config;
}
