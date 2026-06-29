// ponytail: validación de env a mano, sin Joi/class-validator. Falla rápido si falta algo.
const REQUIRED = ['DATABASE_URL', 'REDIS_URL', 'PORT'] as const;

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const missing = REQUIRED.filter((k) => !config[k]);
  if (missing.length) {
    throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);
  }
  return config;
}
