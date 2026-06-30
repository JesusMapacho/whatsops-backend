// Check de decodeWebhook. Correr: npx ts-node src/webhook/decode.check.ts
import * as assert from 'node:assert';
import { decodeWebhook, webhookType } from './decode';

// Payload realista de Meta: 1 mensaje entrante + 1 status, dos changes.
const msgA = { id: 'wamid.A', from: '521555', type: 'text', text: { body: 'hola' } };
const payload = {
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'PN1' },
            contacts: [{ wa_id: '521555', profile: { name: 'Ana' } }],
            messages: [msgA],
          },
        },
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'PN1' },
            statuses: [{ id: 'wamid.B', status: 'delivered', recipient_id: '521555' }],
          },
        },
      ],
    },
  ],
};

const changes = decodeWebhook(payload);
assert.strictEqual(changes.length, 2);

assert.strictEqual(changes[0].phoneNumberId, 'PN1');
assert.deepStrictEqual(changes[0].messages, [
  { wamid: 'wamid.A', from: '521555', type: 'text', payload: msgA, contactName: 'Ana' },
]);
assert.deepStrictEqual(changes[0].statuses, []);

assert.deepStrictEqual(changes[1].statuses, [{ wamid: 'wamid.B', status: 'delivered' }]);
assert.deepStrictEqual(changes[1].messages, []);

assert.strictEqual(webhookType(payload), 'messages');

// Payload vacío / basura no rompe.
assert.deepStrictEqual(decodeWebhook({}), []);
assert.deepStrictEqual(decodeWebhook(null), []);
assert.strictEqual(webhookType({}), 'unknown');

console.log('decode.check OK');
