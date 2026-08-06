// Check de la firma y utilidades de WAHA. Correr: npx ts-node src/webhook/waha.check.ts
import * as assert from 'node:assert';
import { createHmac } from 'node:crypto';
import {
  ACK_STATUS,
  verifyWahaSignature,
  wahaHmacKey,
  wahaSessionName,
  WAHA_EVENTS,
  WAHA_EVENTS_VERSION,
} from './waha';

// --- Eventos suscritos ---
// `message.any` es lo que hace que la bandeja se entere de lo que el dueño manda
// desde su propio teléfono.
assert.ok(WAHA_EVENTS.includes('message.any'), 'falta message.any');
assert.ok(WAHA_EVENTS.includes('message.reaction'));
assert.ok(WAHA_EVENTS.includes('message.revoked'));
assert.ok(WAHA_EVENTS.includes('session.status'));
assert.ok(WAHA_EVENTS.includes('message.ack'));
// NUNCA message.waiting: es el placeholder de un mensaje aún no descifrable. Si se
// decodificara, su wamid quedaría persistido y el mensaje real llegando después
// sería descartado por nuestro propio dedupe, para siempre.
assert.ok(!WAHA_EVENTS.includes('message.waiting'), 'message.waiting NO debe suscribirse');
// La versión tiene que subir cuando cambia la lista, o las sesiones ya emparejadas
// se quedan con la suscripción vieja y los eventos nuevos no llegan nunca.
assert.ok(WAHA_EVENTS_VERSION >= 2, 'subir WAHA_EVENTS_VERSION al cambiar WAHA_EVENTS');
assert.strictEqual(new Set(WAHA_EVENTS).size, WAHA_EVENTS.length, 'sin eventos duplicados');

// --- Nombre de sesión: derivado del tenant, estable ---
assert.strictEqual(wahaSessionName('t1'), 't_t1');
assert.notStrictEqual(wahaSessionName('t1'), wahaSessionName('t2'));

// --- Clave HMAC por sesión: estable, distinta por sesión y por maestro ---
assert.strictEqual(wahaHmacKey('master', 't_a'), wahaHmacKey('master', 't_a'));
assert.notStrictEqual(wahaHmacKey('master', 't_a'), wahaHmacKey('master', 't_b'));
assert.notStrictEqual(wahaHmacKey('master', 't_a'), wahaHmacKey('otro', 't_a'));
assert.strictEqual(wahaHmacKey('master', 't_a').length, 128); // sha512 hex

// --- Firma: HMAC-SHA512 hex sobre el body crudo, SIN prefijo ---
const key = 'my-secret-key';
const body = Buffer.from('{"event":"message","session":"default","engine":"WEBJS"}');
const sig = createHmac('sha512', key).update(body).digest('hex');

assert.ok(verifyWahaSignature(body, sig, key), 'firma válida debe pasar');

// Clave equivocada, body alterado y header ausente/vacío fallan.
assert.ok(!verifyWahaSignature(body, sig, 'otra-key'));
assert.ok(!verifyWahaSignature(Buffer.from('{"event":"x"}'), sig, key));
assert.ok(!verifyWahaSignature(body, undefined, key));
assert.ok(!verifyWahaSignature(body, '', key));

// A diferencia de Meta (`sha256=<hex>`), WAHA NO manda prefijo: con prefijo debe fallar.
assert.ok(!verifyWahaSignature(body, `sha512=${sig}`, key), 'el prefijo no es válido en WAHA');

// Basura no-hex y longitud incorrecta fallan sin lanzar.
assert.ok(!verifyWahaSignature(body, 'no-es-hex', key));
assert.ok(!verifyWahaSignature(body, sig.slice(0, 100), key));
assert.ok(!verifyWahaSignature(body, sig + 'ab', key));

// Un sha256 del mismo body no cuela como sha512 (distinta longitud).
assert.ok(!verifyWahaSignature(body, createHmac('sha256', key).update(body).digest('hex'), key));

// --- Acuses numéricos → MessageStatus ---
assert.strictEqual(ACK_STATUS[-1], 'failed');
assert.strictEqual(ACK_STATUS[0], 'sent');
assert.strictEqual(ACK_STATUS[1], 'sent');
assert.strictEqual(ACK_STATUS[2], 'delivered');
assert.strictEqual(ACK_STATUS[3], 'read');
assert.strictEqual(ACK_STATUS[4], 'read'); // PLAYED se colapsa en read
// Un ack desconocido no inventa un estado (el decoder lo descarta).
assert.strictEqual(ACK_STATUS[99], undefined);

console.log('waha.check OK');
