// Check de los guardarraíles de la capa gratuita.
// Correr: npx ts-node src/messaging/limits.check.ts
import * as assert from 'node:assert';
import { checkLimits, DEFAULT_LIMITS, isCold, limitsFromEnv } from './limits';

const cfg = {
  maxPerContactHour: 4,
  maxPerDay: 200,
  maxColdPerHour: 5,
  maxColdPerDay: 20,
  maxColdPerHourPaid: 30,
  maxColdPerDayPaid: 200,
};

// Conteos en frío a cero, para los casos que sí los necesitan.
const cero = { coldConversationOut: 0, coldTenantHour: 0, coldTenantDay: 0 };

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
  { ...DEFAULT_LIMITS, maxPerContactHour: 2, maxPerDay: 50 },
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

// --- Grupos exentos del ritmo por contacto ---
// 4 mensajes/hora haría inusable cualquier grupo con algo de actividad. El ritmo
// protege de parecer spam ante UNA persona; en un grupo no aplica.
assert.ok(
  checkLimits({ contactLastHour: 99, tenantLastDay: 0 }, cfg, 'free', { isGroup: true }).allowed,
  'un grupo no debe topar con el ritmo por contacto',
);
// Pero el cupo diario SÍ sigue vigente en grupos: protege la reputación del número.
assert.ok(
  !checkLimits({ contactLastHour: 0, tenantLastDay: 200 }, cfg, 'free', { isGroup: true }).allowed,
);
// Y un 1-a-1 no cambia de comportamiento por el parámetro nuevo.
assert.ok(!checkLimits({ contactLastHour: 4, tenantLastDay: 0 }, cfg, 'free', {}).allowed);

// --- Primer contacto (frío) ---
const cold = { isGroup: false, cold: true };
const base = { contactLastHour: 0, tenantLastDay: 0, ...cero };

// isCold es "nunca nos escribió", NO "fuera de la ventana de 24 h": quien escribió
// hace tres días ya nos conoce y no nos marca como spam por retomar.
assert.strictEqual(isCold(null), true);
assert.strictEqual(isCold(new Date('2020-01-01')), false);

// Un primer contacto pasa.
assert.ok(checkLimits(base, cfg, 'free', cold).allowed);

// Un SEGUNDO mensaje al mismo desconocido, no. Sin ventana de tiempo: es la regla que
// de verdad evita juntar las 5-10 marcas de spam que banean un número.
const insiste = checkLimits({ ...base, coldConversationOut: 1 }, cfg, 'free', cold);
assert.ok(!insiste.allowed);
assert.ok(!insiste.allowed && /no ha contestado/.test(insiste.message));

// Topes de conversaciones nuevas por hora y por día (gratis).
assert.ok(!checkLimits({ ...base, coldTenantHour: 5 }, cfg, 'free', cold).allowed);
assert.ok(!checkLimits({ ...base, coldTenantDay: 20 }, cfg, 'free', cold).allowed);
assert.ok(checkLimits({ ...base, coldTenantHour: 4, coldTenantDay: 19 }, cfg, 'free', cold).allowed);

// ANTI-REGRESIÓN CENTRAL: pagar NO exime del tope en frío, solo lo ensancha. En
// caliente el plan pagado sí queda exento (comportamiento de siempre, arriba).
assert.ok(
  !checkLimits({ ...base, coldTenantDay: 200 }, cfg, 'pro', cold).allowed,
  'un plan pagado NO puede molestar a desconocidos sin límite',
);
assert.ok(!checkLimits({ ...base, coldTenantHour: 30 }, cfg, 'pro', cold).allowed);
// Pero por debajo del tope de pago sí puede, donde el gratuito ya estaría cortado.
assert.ok(checkLimits({ ...base, coldTenantHour: 10, coldTenantDay: 100 }, cfg, 'pro', cold).allowed);
assert.ok(!checkLimits({ ...base, coldTenantHour: 10 }, cfg, 'free', cold).allowed);

// Un grupo no se inicia en frío.
const grupoFrio = checkLimits(base, cfg, 'free', { isGroup: true, cold: true });
assert.ok(!grupoFrio.allowed && /grupo/.test(grupoFrio.message));

// El ritmo en caliente NO aplica a un primer contacto: por definición no hay historial.
assert.ok(checkLimits({ ...base, contactLastHour: 99 }, cfg, 'free', cold).allowed);

// Precedencia: gana el mensaje más específico y accionable.
const todos = checkLimits(
  { ...base, coldConversationOut: 1, coldTenantHour: 99, coldTenantDay: 99 },
  cfg, 'free', cold,
);
assert.ok(!todos.allowed && /no ha contestado/.test(todos.message));

// Faltar los conteos en frío es un error de programación, no un "permitido".
assert.throws(
  () => checkLimits({ contactLastHour: 0, tenantLastDay: 0 }, cfg, 'free', cold),
  /conteos en frío/,
);

// Los cuatro env nuevos, y que un '0' siga cayendo al default.
assert.deepStrictEqual(
  limitsFromEnv((k) => ({
    COLD_MAX_PER_HOUR: '2',
    COLD_MAX_PER_DAY: '7',
    COLD_MAX_PER_HOUR_PAID: '50',
    COLD_MAX_PER_DAY_PAID: '500',
  })[k]),
  { ...DEFAULT_LIMITS, maxColdPerHour: 2, maxColdPerDay: 7, maxColdPerHourPaid: 50, maxColdPerDayPaid: 500 },
);
assert.strictEqual(limitsFromEnv(() => '0').maxColdPerDay, DEFAULT_LIMITS.maxColdPerDay);

console.log('limits.check OK');
