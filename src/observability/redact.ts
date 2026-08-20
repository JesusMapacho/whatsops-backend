// Redacción de secretos ANTES de persistir/loguear. Mismo criterio que
// "nunca loguear tokens" de CLAUDE.md. Reutilizable (feature 05 ErrorLog,
// feature 04 PAN). No muta la entrada.

// Claves sensibles (match por substring, case-insensitive).
const SENSITIVE_KEYS = [
  'password',
  'passwordhash',
  'accesstoken',
  'token',
  'authorization',
  'secret',
  'apikey',
  // Con guion: el header de WAHA es `X-Api-Key`, que no contiene "apikey".
  'api-key',
  'clientsecret',
  'webhooksecret',
  'card',
  'cardnumber',
  'pan',
  'cvv',
  'cvc',
  // Listas de destinatarios de un envío masivo (v5 feature 29). No son secretos
  // nuestros: son PII de gente que TODAVÍA NO ES CLIENTE. Sin esto, un 500 al crear
  // el envío persiste el CSV entero en `ErrorLog.requestBody`, que el super-admin lee
  // cross-tenant.
  'csv',
  'recipients',
  'phones',
];

const REDACTED = '[REDACTED]';
// Secuencia tipo tarjeta: 13-19 dígitos (con espacios/guiones opcionales).
const PAN_RE = /\b(?:\d[ -]*?){13,19}\b/g;

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEYS.some((s) => k.includes(s));
}

function redactString(v: string): string {
  return v.replace(PAN_RE, REDACTED);
}

// Redacta recursivamente objetos/arrays. Corta a profundidad razonable.
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

// --- Rutas ---------------------------------------------------------------------------

/**
 * `POST /hooks/<token>` lleva el secreto **en la ruta**, no en el cuerpo. Sin esto, cualquier
 * 404/409/413/415/429 sobre esa ruta persiste el token entero en `ErrorLog.path` — y como no
 * hay sesión, `tenantId` queda a `null`, así que la fila cae en el bucket de plataforma que
 * el super-admin lee **cross-tenant**. Con el token, cualquiera dispara la automatización.
 */
export function esRutaDeHook(path: string): boolean {
  return /^\/hooks\/[^/]/.test(path);
}

/** La misma ruta con el token tapado. No toca ninguna otra. */
export function redactPath(path: string): string {
  return esRutaDeHook(path) ? '/hooks/' + REDACTED : path;
}
