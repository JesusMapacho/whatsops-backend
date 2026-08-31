// ponytail: validación de env a mano, sin Joi/class-validator. Falla rápido si falta algo.
const REQUIRED = ['DATABASE_URL', 'PORT', 'JWT_SECRET', 'ENCRYPTION_KEY', 'WEBHOOK_VERIFY_TOKEN', 'META_APP_SECRET'] as const;

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

// Valores de ejemplo que NO pueden llegar a producción. Están publicados en
// `.env.example`, o sea que son públicos: `WAHA_WEBHOOK_SECRET=cambia-esto` deja que
// cualquiera firme un webhook válido para `t_<tenantId>` —nombre derivado y enumerable— e
// inyecte mensajes falsos en la bandeja de cualquier negocio. `ENCRYPTION_KEY` de ceros
// descifra los tokens de todos los tenants.
//
// Se comprueba el VALOR y no la clave: así una variable nueva copiada del ejemplo entra en
// la red sin que nadie tenga que acordarse de añadirla a una lista.
const PLACEHOLDERS = new Set([
  'cambia-esto',
  'cambia-esto-en-produccion',
  'dev-waha-key',
  'dev-waha-webhook-secret',
  '0000000000000000000000000000000000000000000000000000000000000000',
  // El peor de todos: es la contraseña del super-admin CROSS-TENANT, y
  // `platform.service.ts` la siembra en cada arranque.
  'change-me-please',
  'dev-metrics-token',
  'dev-billing-secret',
  'dev-pos-bridge-secret',
]);

// Credenciales de ejemplo dentro de una URL. No se pueden comparar por igualdad porque el
// secreto va embebido, así que se busca la subcadena.
const URLS_CON_CREDENCIAL: Array<[string, string]> = [['DATABASE_URL', 'whatsops:whatsops@']];

// Claves cuyo valor es un secreto. No se listan las que no lo son (URLs, puertos): un
// `WAHA_URL` de ejemplo es un error de config, no un agujero.
const SECRETS = [
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'WEBHOOK_VERIFY_TOKEN',
  'META_APP_SECRET',
  'WAHA_API_KEY',
  'WAHA_WEBHOOK_SECRET',
  'METRICS_TOKEN',
  'LLM_API_KEY',
  'PLATFORM_ADMIN_PASSWORD',
  'STRIPE_WEBHOOK_SECRET',
  'POS_SERVICE_SECRET',
] as const;

// Mismo criterio que `session-cookie.ts`: producción es el default y de dev se sale
// explícitamente con COOKIE_SECURE=false. Al revés —confiar en NODE_ENV=production, que
// este repo no usa en ningún sitio— un despliegue que la olvide se saltaría el freno justo
// cuando más falta hace.
function esDesarrollo(config: Record<string, unknown>): boolean {
  return config.COOKIE_SECURE === 'false';
}

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
  if (!esDesarrollo(config)) {
    const ejemplo: string[] = SECRETS.filter((k) => PLACEHOLDERS.has(String(config[k] ?? '')));
    for (const [clave, aguja] of URLS_CON_CREDENCIAL) {
      if (String(config[clave] ?? '').includes(aguja)) ejemplo.push(clave);
    }
    if (ejemplo.length) {
      throw new Error(
        `Estas variables siguen con el valor de .env.example y son públicas: ${ejemplo.join(', ')}. ` +
          'Genera valores nuevos (por ejemplo `openssl rand -hex 32`) o pon COOKIE_SECURE=false si esto es tu máquina.',
      );
    }
  }
  return config;
}
