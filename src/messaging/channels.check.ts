// Check de los adaptadores de canal. Correr: npx ts-node src/messaging/channels.check.ts
import * as assert from 'node:assert';
import { channelAdapter } from './channels';

const wa = channelAdapter('whatsapp');
const msn = channelAdapter('messenger');
const ig = channelAdapter('instagram');

// URL de envío: /{externalId}/messages en todos.
assert.strictEqual(wa.sendUrl('PN1', 'v22.0'), 'https://graph.facebook.com/v22.0/PN1/messages');
assert.strictEqual(msn.sendUrl('PAGE1', 'v22.0'), 'https://graph.facebook.com/v22.0/PAGE1/messages');

// WhatsApp: payload Cloud API con messaging_product.
const waText = wa.buildText('521555', { type: 'text', text: 'hola' }) as any;
assert.strictEqual(waText.messaging_product, 'whatsapp');
assert.strictEqual(waText.text.body, 'hola');
assert.ok(wa.supportsTemplate && wa.needsMediaUpload);

// Messenger/IG: payload Send API con recipient.id, sin messaging_product; comparten adaptador.
assert.strictEqual(msn, ig);
const msnText = msn.buildText('PSID9', { type: 'text', text: 'hey' }) as any;
assert.strictEqual(msnText.recipient.id, 'PSID9');
assert.strictEqual(msnText.message.text, 'hey');
assert.strictEqual(msnText.messaging_product, undefined);
assert.ok(!msn.supportsTemplate && !msn.needsMediaUpload);

// Messenger no soporta plantillas → lanza.
assert.throws(() => msn.buildText('PSID9', { type: 'template', name: 'x', language: 'es' } as any));

// Media: WA referencia por media-id; Messenger por URL (attachment.payload.url).
const waMedia = wa.buildMedia('521555', 'image', 'MEDIA_ID', {}) as any;
assert.strictEqual(waMedia.image.id, 'MEDIA_ID');
const msnMedia = msn.buildMedia('PSID9', 'image', 'https://cdn/x.jpg', {}) as any;
assert.strictEqual(msnMedia.message.attachment.type, 'image');
assert.strictEqual(msnMedia.message.attachment.payload.url, 'https://cdn/x.jpg');
// document → 'file' en Messenger.
assert.strictEqual((msn.buildMedia('P', 'document', 'u', {}) as any).message.attachment.type, 'file');

// mapError genérico en messaging.
assert.strictEqual(msn.mapError({ error: { message: 'nope' } }), 'nope');

console.log('channels.check OK');
