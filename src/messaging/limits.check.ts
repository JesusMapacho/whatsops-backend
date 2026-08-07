// Check de los guardarraíles de la capa gratuita.
// Correr: npx ts-node src/messaging/limits.check.ts
import * as assert from 'node:assert';
import { checkLimits, DEFAULT_LIMITS, limitsFromEnv } from './limits';

const cfg = { maxPerContactHour: 4, maxPerDay: 200 };

// --- Dentro de límites: pasa ---
assert.ok(checkLimits({ contactLastHour: 0, tenantLastDay: 0 }, cfg, 'free').allowed);
assert.ok(checkLimits({ contactLastHour: 3, tenantLastDay: 199 }, cfg, 'free').allowed);

// --- Ritmo por contacto: el 5º en una hora se corta (límite ban-crítico) ---
const paced = checkLimits({ contactLastHour: 4, tenantLastDay: 0 }, cfg, 'free');
assert.ok(!paced.allowed);
assert.ok(!paced.allowed && /mismo contacto/.test(paced.message));
// El mensaje explica el por qué, no solo el qué: el agente tiene que entender que
// es para no perder el número.
assert.ok(!paced.allowed && /bloquee tu número/.test(paced.message));

// --- Cupo diario del tenant ---
const daily = checkLimits({ contactLastHour: 0, tenantLastDay: 200 }, cfg, 'free');
assert.ok(!daily.allowed);
assert.ok(!daily.allowed && /cupo diario/.test(daily.message));

// El ritmo por contacto gana si ambos topan (es el que arriesga el baneo).
const both = checkLimits({ contactLastHour: 9, tenantLastDay: 999 }, cfg, 'free');
assert.ok(!both.allowed && /mismo contacto/.test(both.message));

// --- Un plan pagado queda exento: usa la API oficial y tiene sus propias reglas ---
assert.ok(checkLimits({ contactLastHour: 99, tenantLastDay: 9999 }, cfg, 'pro').allowed);
assert.ok(checkLimits({ contactLastHour: 99, tenantLastDay: 9999 }, cfg, 'starter').allowed);

// --- Config desde env: valores válidos mandan, ausentes/basura caen al default ---
assert.deepStrictEqual(
  limitsFromEnv((k) => ({ WAHA_MAX_PER_CONTACT_HOUR: '2', WAHA_MAX_PER_DAY: '50' })[k]),
  { maxPerContactHour: 2, maxPerDay: 50 },
);
assert.deepStrictEqual(limitsFromEnv(() => undefined), DEFAULT_LIMITS);
assert.deepStrictEqual(limitsFromEnv(() => 'no-es-un-numero'), DEFAULT_LIMITS);
// Un 0 en env no debe desactivar el límite por accidente (0 || def → def).
assert.deepStrictEqual(limitsFromEnv(() => '0'), DEFAULT_LIMITS);

// El default del ritmo es el de la guía de WAHA.
assert.strictEqual(DEFAULT_LIMITS.maxPerContactHour, 4);

// --- El eco del teléfono no debe bloquear al agente ---
// `contactLastHour` llega ya SIN los mensajes marcados viaDevice (lo filtra la
// query). Con 4 respuestas del dueño desde el celular, el agente sigue pudiendo
// enviar; lo que se agota es el cupo diario, que sí las cuenta.
assert.ok(
  checkLimits({ contactLastHour: 0, tenantLastDay: 4 }, cfg, 'free').allowed,
  '4 mensajes del teléfono no deben bloquear al agente',
);
// Pero el cupo diario sí los ve y corta al llegar al tope.
assert.ok(!checkLimits({ contactLastHour: 0, tenantLastDay: 200 }, cfg, 'free').allowed);

console.log('limits.check OK');
