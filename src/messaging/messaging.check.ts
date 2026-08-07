// Check de las utilidades de mensajería. Correr: npx ts-node src/messaging/messaging.check.ts
import * as assert from 'node:assert';
import {
  buildMessagePayload,
  isWithinWindow,
  mapGraphError,
  storedTextPayload,
  templateBody,
} from './messaging.util';

// --- Ventana de 24 h ---
const now = new Date('2026-06-30T12:00:00Z');
assert.strictEqual(isWithinWindow(new Date('2026-06-30T11:00:00Z'), now), true); // 1 h
assert.strictEqual(isWithinWindow(new Date('2026-06-29T11:00:00Z'), now), false); // 25 h
assert.strictEqual(isWithinWindow(null, now), false); // nunca escribió

// --- Cuerpo Graph ---
assert.deepStrictEqual(buildMessagePayload('521555', { type: 'text', text: 'hola' }), {
  messaging_product: 'whatsapp',
  to: '521555',
  type: 'text',
  text: { body: 'hola' },
});
assert.deepStrictEqual(
  buildMessagePayload('521555', { type: 'template', name: 'bienvenida', language: 'es' }),
  {
    messaging_product: 'whatsapp',
    to: '521555',
    type: 'template',
    template: { name: 'bienvenida', language: { code: 'es' } },
  },
);

// --- Payload PERSISTIDO de un saliente: siempre `text.body`, sea cual sea el canal ---
// Regresión del bug de la burbuja vacía: se guardaba el cuerpo del proveedor, y en
// WAHA `text` era un string, así que la bandeja (que lee payload.text.body) pintaba
// una burbuja vacía y la búsqueda no encontraba nada.
assert.deepStrictEqual(storedTextPayload({ type: 'text', text: 'hola' }), {
  text: { body: 'hola' },
});
// Nada de fugas del transporte (session/chatId/recipient) a una columna que va al navegador.
const stored = storedTextPayload({ type: 'text', text: 'hola' }) as any;
assert.strictEqual(stored.session, undefined);
assert.strictEqual(stored.chatId, undefined);
assert.strictEqual(stored.recipient, undefined);
assert.strictEqual(typeof stored.text, 'object', 'text debe ser objeto, no string');

// Las plantillas conservan la forma que ya leía el frontend (payload.template.name).
assert.deepStrictEqual(
  storedTextPayload({ type: 'template', name: 'bienvenida', language: 'es' }),
  { template: { name: 'bienvenida', language: { code: 'es' } } },
);
assert.deepStrictEqual(
  storedTextPayload({ type: 'template', name: 'x', language: 'es', components: [{ type: 'BODY' }] }),
  { template: { name: 'x', language: { code: 'es' }, components: [{ type: 'BODY' }] } },
);

// --- La cita, y que el `components` construido llegue al cuerpo de Meta ---
assert.deepStrictEqual(
  (buildMessagePayload('521555', { type: 'text', text: 'x', replyTo: 'W1' }) as any).context,
  { message_id: 'W1' },
);
// Sin variables NO debe aparecer la clave `components`: Meta la rechaza vacía.
const sinVars = buildMessagePayload('521555', {
  type: 'template',
  name: 'aviso',
  language: 'es',
}) as any;
assert.ok(!('components' in sinVars.template));
// Con variables, se pasa tal cual la construyó el servidor.
const conVars = buildMessagePayload('521555', {
  type: 'template',
  name: 'pedido',
  language: 'es',
  components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }] }],
}) as any;
assert.deepStrictEqual(conVars.template.components, [
  { type: 'body', parameters: [{ type: 'text', text: 'Ana' }] },
]);

// El payload PERSISTIDO de una plantilla conserva las variables, para que el hilo
// muestre lo que de verdad se envió.
assert.deepStrictEqual(
  storedTextPayload({
    type: 'template',
    name: 'pedido',
    language: 'es',
    components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }] }],
  } as any),
  {
    template: {
      name: 'pedido',
      language: { code: 'es' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }] }],
    },
  },
);

// --- Mapeo de errores ---
assert.match(mapGraphError({ error: { code: 190 } }), /Token/);
assert.match(mapGraphError({ error: { code: 132001 } }), /Plantilla/);
assert.strictEqual(mapGraphError({ error: { code: 999, message: 'boom' } }), 'boom');

// --- templateBody ---
assert.strictEqual(
  templateBody([{ type: 'BODY', text: 'Hola {{1}}' }, { type: 'FOOTER', text: 'x' }]),
  'Hola {{1}}',
);
assert.strictEqual(templateBody(undefined), null);

console.log('messaging.check OK');
