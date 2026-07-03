// ponytail: validación de env a mano, sin Joi/class-validator. Falla rápido si falta algo.
const REQUIRED = ['DATABASE_URL', 'REDIS_URL', 'PORT', 'JWT_SECRET', 'ENCRYPTION_KEY', 'WEBHOOK_VERIFY_TOKEN', 'META_APP_SECRET'] as const;

// El asistente (v1.5) es opcional: la app arranca sin él. Pero si se configura
// (aparece LLM_MODEL), exigimos el grupo completo para no arrancar a medias.
const ASSISTANT_GROUP = ['LLM_MODEL', 'LLM_API_KEY'] as const;

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
  return config;
}
