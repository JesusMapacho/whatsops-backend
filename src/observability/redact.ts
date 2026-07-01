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
  'clientsecret',
  'webhooksecret',
  'card',
  'cardnumber',
  'pan',
  'cvv',
  'cvc',
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
