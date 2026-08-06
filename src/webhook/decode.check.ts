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

// --- WAHA: envelope propio { event, session, payload }, sin `object` ---
const wahaEnvelope = (event: string, payload: object) => ({
  id: 'evt_1',
  timestamp: 1741249702485,
  event,
  session: 't_tenant1',
  me: { id: '5215550000@c.us', pushName: 'Yo' },
  payload,
  engine: 'NOWEB',
});

// Mensaje de texto entrante.
const wText = decodeWebhook(
  wahaEnvelope('message', {
    id: 'false_521555@c.us_AAA',
    timestamp: 1741249702,
    from: '521555@c.us',
    fromMe: false,
    to: '5215550000@c.us',
    body: 'hola',
    hasMedia: false,
    _data: { notifyName: 'Ana' },
  }),
);
assert.strictEqual(wText.length, 1);
assert.strictEqual(wText[0].platform, 'waha');
assert.strictEqual(wText[0].channelRef, 't_tenant1'); // el tenant se resuelve por la sesión
assert.strictEqual(wText[0].messages.length, 1);
assert.strictEqual(wText[0].messages[0].wamid, 'false_521555@c.us_AAA');
assert.strictEqual(wText[0].messages[0].from, '521555@c.us');
assert.strictEqual(wText[0].messages[0].type, 'text');
assert.strictEqual(wText[0].messages[0].contactName, 'Ana');
// Normalizado a la forma de Meta para que la bandeja lo pinte sin cambios.
assert.strictEqual((wText[0].messages[0].payload as any).text.body, 'hola');

// Eco de lo que enviamos nosotros: no se reingesta.
const wEcho = decodeWebhook(
  wahaEnvelope('message', { id: 'x', from: '521555@c.us', fromMe: true, body: 'mío' }),
);
assert.deepStrictEqual(wEcho[0].messages, []);

// Grupos, canales y difusión se descartan: llenarían la bandeja de basura.
for (const from of ['12312312@g.us', 'status@broadcast', '99999@newsletter']) {
  const out = decodeWebhook(wahaEnvelope('message', { id: 'g1', from, body: 'x' }));
  assert.deepStrictEqual(out[0].messages, [], `debe descartar ${from}`);
}

// --- LID addressing: payload REAL capturado del engine NOWEB ---
// WhatsApp moderno direcciona con `@lid` en vez de `@c.us`. Un filtro de lista
// blanca sobre `@c.us` descartaba estos mensajes EN SILENCIO (bug encontrado en
// pruebas locales: el mensaje llegaba, el evento se procesaba `ok` y no aparecía
// nada en la bandeja).
const lidReal = decodeWebhook(
  wahaEnvelope('message', {
    id: 'false_175647100039313@lid_ACFFC1CAAF9CAE35311F5DD3F9ABE083',
    timestamp: 1785000000,
    from: '175647100039313@lid',
    fromMe: false,
    source: 'app',
    body: 'No te entendi xd',
    hasMedia: false,
    ack: 1,
    _data: {
      pushName: 'Dieand',
      key: {
        id: 'ACFFC1CAAF9CAE35311F5DD3F9ABE083',
        fromMe: false,
        remoteJid: '175647100039313@lid',
        remoteJidAlt: '5218715172350@s.whatsapp.net',
        addressingMode: 'lid',
      },
    },
  }),
);
assert.strictEqual(lidReal[0].messages.length, 1, 'un mensaje con @lid NO debe descartarse');
assert.strictEqual(lidReal[0].messages[0].from, '175647100039313@lid');
assert.strictEqual(lidReal[0].messages[0].type, 'text');
assert.strictEqual((lidReal[0].messages[0].payload as any).text.body, 'No te entendi xd');
// El engine NOWEB pone el nombre en `_data.pushName`, no en `notifyName`.
assert.strictEqual(lidReal[0].messages[0].contactName, 'Dieand');

// `@s.whatsapp.net` también es un chat directo.
assert.strictEqual(
  decodeWebhook(wahaEnvelope('message', { id: 'w1', from: '521871@s.whatsapp.net', body: 'x' }))[0]
    .messages.length,
  1,
);
// Un eco propio se sigue descartando aunque venga con LID.
assert.deepStrictEqual(
  decodeWebhook(wahaEnvelope('message', { id: 'e', from: '111@lid', fromMe: true, body: 'x' }))[0]
    .messages,
  [],
);

// Media entrante: el tipo sale del mime.
const wImg = decodeWebhook(
  wahaEnvelope('message', {
    id: 'img1',
    from: '521555@c.us',
    fromMe: false,
    body: 'mira',
    hasMedia: true,
    media: { url: 'http://waha:3000/api/files/x.jpg', mimetype: 'image/jpeg', filename: 'x.jpg' },
  }),
);
assert.strictEqual(wImg[0].messages[0].type, 'image');
// hasMedia sin mime → se trata como texto, no revienta.
const wNoMime = decodeWebhook(
  wahaEnvelope('message', { id: 'n1', from: '521555@c.us', body: 'x', hasMedia: true }),
);
assert.strictEqual(wNoMime[0].messages[0].type, 'text');

// Acuses: solo de nuestros salientes, y mapeados al enum.
const wAck = decodeWebhook(
  wahaEnvelope('message.ack', { id: 'out1', from: '521555@c.us', fromMe: true, ack: 3, ackName: 'READ' }),
);
assert.deepStrictEqual(wAck[0].statuses, [{ wamid: 'out1', status: 'read' }]);
assert.deepStrictEqual(wAck[0].messages, []);
assert.deepStrictEqual(
  decodeWebhook(wahaEnvelope('message.ack', { id: 'o', fromMe: true, ack: 2 }))[0].statuses,
  [{ wamid: 'o', status: 'delivered' }],
);
// Ack desconocido o de un entrante → nada que actualizar.
assert.deepStrictEqual(
  decodeWebhook(wahaEnvelope('message.ack', { id: 'o', fromMe: true, ack: 99 }))[0].statuses,
  [],
);
assert.deepStrictEqual(
  decodeWebhook(wahaEnvelope('message.ack', { id: 'o', fromMe: false, ack: 3 }))[0].statuses,
  [],
);

// Estado de sesión: ni mensajes ni acuses, solo sessionStatus.
const wSess = decodeWebhook(wahaEnvelope('session.status', { status: 'SCAN_QR_CODE' }));
assert.strictEqual(wSess[0].sessionStatus, 'SCAN_QR_CODE');
assert.deepStrictEqual(wSess[0].messages, []);
assert.deepStrictEqual(wSess[0].statuses, []);

// Evento al que no estamos suscritos: se ignora sin error.
assert.deepStrictEqual(decodeWebhook(wahaEnvelope('presence.update', { id: 'x' })), []);

// webhookType usa el `event` real: si no, la auditoría muestra 'unknown' en todo.
assert.strictEqual(webhookType(wahaEnvelope('message.ack', {})), 'message.ack');
assert.strictEqual(webhookType(wahaEnvelope('message', {})), 'message');

// Un envelope de WAHA NO debe caer en el decoder de WhatsApp (que lo daría por vacío).
assert.notStrictEqual(decodeWebhook(wahaEnvelope('message', { id: 'a', from: '1@c.us' })).length, 0);

console.log('decode.check OK');
