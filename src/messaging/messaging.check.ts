// Check de las utilidades de mensajería. Correr: npx ts-node src/messaging/messaging.check.ts
import * as assert from 'node:assert';
import {
  buildMessagePayload,
  isWithinWindow,
  mapGraphError,
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
