// Check de la validación de env. Correr: npx ts-node src/config/env.validation.check.ts
import * as assert from 'node:assert';
import { validateEnv } from './env.validation';

// Lo mínimo para pasar el bloque de REQUIRED, con valores que no son de ejemplo.
const BASE = {
  DATABASE_URL: 'postgresql://u:p@h:5432/d',
  REDIS_URL: 'redis://localhost:6379',
  PORT: '3000',
  JWT_SECRET: 'a3f9c1',
  ENCRYPTION_KEY: 'ab'.repeat(32),
  WEBHOOK_VERIFY_TOKEN: 'tok-real',
  META_APP_SECRET: 'sec-real',
};

// --- lo que tiene que pasar ---------------------------------------------------------
assert.ok(validateEnv({ ...BASE }), 'una config sana pasa');
assert.ok(validateEnv({ ...BASE, COOKIE_SECURE: 'false' }), 'dev también pasa');

// --- presencia (comportamiento preexistente) ---------------------------------------
assert.throws(() => validateEnv({ ...BASE, PORT: '' }), /Faltan variables/);
assert.throws(() => validateEnv({ ...BASE, LLM_MODEL: 'x' }), /Asistente mal configurado/);
assert.throws(() => validateEnv({ ...BASE, WAHA_URL: 'http://x' }), /WAHA mal configurado/);

// --- valores de ejemplo: el freno nuevo --------------------------------------------
// En dev pasan (es justo lo que hay en el .env de tu máquina).
assert.ok(
  validateEnv({ ...BASE, COOKIE_SECURE: 'false', JWT_SECRET: 'cambia-esto-en-produccion' }),
  'en dev los valores de ejemplo se aceptan',
);

// Sin la marca de dev, no. Uno por cada secreto de la lista.
for (const [clave, valor] of [
  ['JWT_SECRET', 'cambia-esto-en-produccion'],
  ['ENCRYPTION_KEY', '0'.repeat(64)],
  ['WEBHOOK_VERIFY_TOKEN', 'cambia-esto'],
  ['META_APP_SECRET', 'cambia-esto'],
  ['METRICS_TOKEN', 'cambia-esto'],
  ['METRICS_TOKEN', 'dev-metrics-token'],
  // La contraseña del super-admin cross-tenant. Es la peor de la lista.
  ['PLATFORM_ADMIN_PASSWORD', 'change-me-please'],
  ['STRIPE_WEBHOOK_SECRET', 'dev-billing-secret'],
]) {
  assert.throws(
    () => validateEnv({ ...BASE, [clave]: valor }),
    new RegExp(clave),
    `${clave}=${valor} no puede pasar fuera de dev`,
  );
}

// Los de WAHA, con el grupo completo para no chocar antes con la validación de presencia.
const CON_WAHA = {
  ...BASE,
  WAHA_URL: 'http://127.0.0.1:3002',
  WAHA_CALLBACK_URL: 'http://host:3000/webhook/waha',
  WAHA_API_KEY: 'key-real',
  WAHA_WEBHOOK_SECRET: 'secreto-real',
};
assert.ok(validateEnv({ ...CON_WAHA }), 'WAHA con secretos reales pasa');
assert.throws(() => validateEnv({ ...CON_WAHA, WAHA_API_KEY: 'dev-waha-key' }), /WAHA_API_KEY/);
assert.throws(
  () => validateEnv({ ...CON_WAHA, WAHA_WEBHOOK_SECRET: 'cambia-esto' }),
  /WAHA_WEBHOOK_SECRET/,
);
// El otro .env.example de la raíz trae este; también es público.
assert.throws(
  () => validateEnv({ ...CON_WAHA, WAHA_WEBHOOK_SECRET: 'dev-waha-webhook-secret' }),
  /WAHA_WEBHOOK_SECRET/,
);

// El mensaje nombra TODAS las que están mal, no solo la primera: si no, arreglas una,
// vuelves a arrancar y te encuentras la siguiente.
assert.throws(
  () => validateEnv({ ...BASE, JWT_SECRET: 'cambia-esto-en-produccion', META_APP_SECRET: 'cambia-esto' }),
  (e: Error) => /JWT_SECRET/.test(e.message) && /META_APP_SECRET/.test(e.message),
);

// DATABASE_URL lleva el secreto embebido, así que se busca la subcadena y no la igualdad.
assert.throws(
  () => validateEnv({ ...BASE, DATABASE_URL: 'postgresql://whatsops:whatsops@127.0.0.1:5433/whatsops' }),
  /DATABASE_URL/,
);
assert.ok(
  validateEnv({ ...BASE, DATABASE_URL: 'postgresql://whatsops:otra-real@127.0.0.1:5433/whatsops' }),
  'mismo usuario con contraseña distinta sí pasa',
);
assert.ok(
  validateEnv({ ...BASE, COOKIE_SECURE: 'false', DATABASE_URL: 'postgresql://whatsops:whatsops@h/d' }),
  'en dev la de ejemplo se acepta',
);

// Un valor que solo CONTIENE el placeholder no es el placeholder: comparación exacta.
assert.ok(validateEnv({ ...BASE, JWT_SECRET: 'cambia-esto-en-produccion-ya-lo-hice' }));

// Las URLs no son secretos: un WAHA_URL de ejemplo es config, no agujero.
assert.ok(validateEnv({ ...CON_WAHA, WAHA_URL: 'http://127.0.0.1:3002' }));

console.log('env.validation: ok');
