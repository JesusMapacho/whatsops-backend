// Check del ciclo de vida del contacto. Correr: npx ts-node src/messaging/lifecycle.check.ts
import * as assert from 'node:assert';
import {
  canSend,
  contactStage,
  DEFAULT_LIFECYCLE,
  lifecycleFromEnv,
  LifecycleInput,
} from './lifecycle';

const cfg = DEFAULT_LIFECYCLE; // 7 días de espera, 2 intentos, ventana de 24 h
const now = new Date('2026-08-10T12:00:00Z');
const haceHoras = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);

const stage = (over: Partial<LifecycleInput>) =>
  contactStage({ lastInboundAt: null, outCount: 0, lastOutAt: null, now, ...over }, cfg);

// ── Prospección: nunca ha contestado ──────────────────────────────────────────
// Sin salientes: se puede escribir.
assert.strictEqual(stage({}), 'pendiente');

// Un intento, recién hecho: a esperar.
assert.strictEqual(stage({ outCount: 1, lastOutAt: haceHoras(1) }), 'enfriando');
// Un intento hace 6 días: sigue enfriando (la espera es de 7).
assert.strictEqual(stage({ outCount: 1, lastOutAt: haceHoras(6 * 24) }), 'enfriando');
// Un intento hace 7 días justos: ya se puede el segundo.
assert.strictEqual(stage({ outCount: 1, lastOutAt: haceHoras(7 * 24) }), 'pendiente');

// LA ASERCIÓN QUE SUSTITUYE AL FRENO VIEJO: al segundo intento sin respuesta se cierra
// PARA SIEMPRE. Sin este tope el modelo sería "un mensaje cada semana indefinidamente",
// que es acoso y es justo lo que junta las marcas de spam que banean un número.
assert.strictEqual(stage({ outCount: 2, lastOutAt: haceHoras(1) }), 'agotada');
assert.strictEqual(stage({ outCount: 2, lastOutAt: haceHoras(365 * 24) }), 'agotada');
assert.strictEqual(stage({ outCount: 9, lastOutAt: haceHoras(365 * 24) }), 'agotada');
// Y `agotada` no se desbloquea con el tiempo, que es todo el punto.
assert.strictEqual(canSend({ lastInboundAt: null, outCount: 2, lastOutAt: haceHoras(1000), now }, cfg).ok, false);

// El reloj del enfriamiento cuenta desde el ÚLTIMO SALIENTE, no desde que se creó la
// conversación: si contara desde la creación, un contacto viejo permitiría insistir de
// inmediato. `lastOutAt` nulo con salientes contados no debe bloquear (dato incoherente
// → se permite y el tope de intentos sigue protegiendo).
assert.strictEqual(stage({ outCount: 1, lastOutAt: null }), 'pendiente');

// ── Ya contestó: ventana de 24 h ──────────────────────────────────────────────
// Contestó hace un rato: charla libre.
assert.strictEqual(stage({ lastInboundAt: haceHoras(2), outCount: 3, lastOutAt: haceHoras(1) }), 'activa');
// Contestó hace 23 h: sigue abierta.
assert.strictEqual(stage({ lastInboundAt: haceHoras(23), outCount: 1, lastOutAt: haceHoras(1) }), 'activa');
// El tope de intentos NO aplica aquí: quien contestó puede recibir todos los que hagan
// falta mientras la ventana esté abierta.
assert.strictEqual(stage({ lastInboundAt: haceHoras(1), outCount: 50, lastOutAt: haceHoras(1) }), 'activa');

// Ventana cerrada y sin saliente posterior a su respuesta: queda una reactivación.
assert.strictEqual(stage({ lastInboundAt: haceHoras(30), outCount: 1, lastOutAt: haceHoras(40) }), 'reactivable');
// Reactivación ya mandada (saliente POSTERIOR a su respuesta): a esperar.
assert.strictEqual(
  stage({ lastInboundAt: haceHoras(30), outCount: 2, lastOutAt: haceHoras(29) }),
  'reactivada-enfriando',
);
// Y pasados los 7 días se puede volver a intentar: la reactivación es REPETIBLE. El tope
// de 2 es de la prospección; a quien ya contestó no se le cierra la puerta para siempre
// porque eso dejaría sin poder hablar a un cliente que ya compró.
assert.strictEqual(
  stage({ lastInboundAt: haceHoras(20 * 24), outCount: 5, lastOutAt: haceHoras(8 * 24) }),
  'reactivable',
);

// ── canSend: qué se permite y qué dice el mensaje ─────────────────────────────
const permitidas = [
  stage({}),
  stage({ lastInboundAt: haceHoras(1) }),
  stage({ lastInboundAt: haceHoras(30), outCount: 1, lastOutAt: haceHoras(40) }),
];
assert.deepStrictEqual(permitidas, ['pendiente', 'activa', 'reactivable']);

const bloqueado = canSend({ lastInboundAt: null, outCount: 1, lastOutAt: haceHoras(1), now }, cfg);
assert.strictEqual(bloqueado.ok, false);
// El mensaje trae la FECHA en que se podrá: "bloqueado" sin fecha es una pared, y el
// operador acaba escribiendo desde su teléfono para saltárselo.
assert.ok(!bloqueado.ok && /\d\d\/\d\d/.test(bloqueado.message), bloqueado.ok ? '' : bloqueado.message);
// Con 7 días de espera desde hace 1 h, la fecha cae 7 días menos 1 h por delante.
assert.ok(!bloqueado.ok && bloqueado.message.includes('17/08'));

const agotado = canSend({ lastInboundAt: null, outCount: 2, lastOutAt: haceHoras(1), now }, cfg);
assert.ok(!agotado.ok && agotado.message.includes('2 veces'));
// El de agotada NO promete una fecha, porque no hay ninguna.
assert.ok(!agotado.ok && !/\d\d\/\d\d/.test(agotado.message));

// ── Config por env ────────────────────────────────────────────────────────────
assert.deepStrictEqual(
  lifecycleFromEnv((k) => ({ COLD_COOLDOWN_HOURS: '72', COLD_MAX_ATTEMPTS: '3' })[k]),
  { cooldownHours: 72, maxColdAttempts: 3, windowHours: 24 },
);
// Valor basura → el de por defecto, nunca 0 (un 0 desactivaría el freno en silencio).
assert.deepStrictEqual(lifecycleFromEnv(() => 'x'), DEFAULT_LIFECYCLE);
assert.deepStrictEqual(lifecycleFromEnv(() => '0'), DEFAULT_LIFECYCLE);

console.log('lifecycle.check OK');
