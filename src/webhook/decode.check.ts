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

assert.strictEqual(changes[0].platform, 'whatsapp');
assert.strictEqual(changes[0].channelRef, 'PN1');
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

// --- Messenger (object:'page') ---
const msnMsg = { mid: 'm.msn1', text: 'hey' };
const msnImg = { mid: 'm.msn2', attachments: [{ type: 'image', payload: { url: 'https://cdn/x.jpg' } }] };
const msn = {
  object: 'page',
  entry: [
    {
      id: 'PAGE123',
      messaging: [
        { sender: { id: 'PSID9' }, recipient: { id: 'PAGE123' }, message: msnMsg },
        { sender: { id: 'PSID9' }, recipient: { id: 'PAGE123' }, message: msnImg },
        { sender: { id: 'PSID9' }, delivery: { mids: ['m.out1'] } },
      ],
    },
  ],
};
const mc = decodeWebhook(msn);
assert.strictEqual(mc.length, 1);
assert.strictEqual(mc[0].platform, 'messenger');
assert.strictEqual(mc[0].channelRef, 'PAGE123');
assert.deepStrictEqual(mc[0].messages, [
  { wamid: 'm.msn1', from: 'PSID9', type: 'text', payload: msnMsg, contactName: null },
  { wamid: 'm.msn2', from: 'PSID9', type: 'image', payload: msnImg, contactName: null },
]);
assert.deepStrictEqual(mc[0].statuses, [{ wamid: 'm.out1', status: 'delivered' }]);
assert.strictEqual(webhookType(msn), 'page');

// --- Instagram (object:'instagram') — misma forma, otro platform ---
const ig = {
  object: 'instagram',
  entry: [{ id: 'IG55', messaging: [{ sender: { id: 'IGSID7' }, message: { mid: 'm.ig1', text: 'hola ig' } }] }],
};
const ic = decodeWebhook(ig);
assert.strictEqual(ic[0].platform, 'instagram');
assert.strictEqual(ic[0].channelRef, 'IG55');
assert.strictEqual(ic[0].messages[0].from, 'IGSID7');
assert.strictEqual(ic[0].messages[0].type, 'text');

console.log('decode.check OK');
