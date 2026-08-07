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

// Un `fromMe` ya NO se descarta (feature 28): entra como saliente. La duplicación
// de nuestros propios envíos por API la corta el dedupe por (tenantId, wamid).
const wEcho = decodeWebhook(
  wahaEnvelope('message', { id: 'x', from: '521555@c.us', fromMe: true, body: 'mío' }),
);
assert.strictEqual(wEcho[0].messages.length, 1);
assert.strictEqual(wEcho[0].messages[0].direction, 'out');

// Canales y difusión se descartan: llenarían la bandeja de basura.
// Los GRUPOS sí se atienden desde la feature 28 (ver más abajo).
for (const from of ['status@broadcast', '99999@newsletter']) {
  const out = decodeWebhook(wahaEnvelope('message', { id: 'g1', from, body: 'x' }));
  assert.deepStrictEqual(out[0].messages, [], `debe descartar ${from}`);
}

// --- Grupos ---
// En un grupo, `from` es el GRUPO y quien habló va en `participant`. Sin separarlo,
// todos los miembros colapsarían en un solo contacto cuyo nombre cambiaría con cada
// mensaje, y el hilo no diría quién dijo qué.
const grupo = decodeWebhook(
  wahaEnvelope('message', {
    id: 'false_12345-1600000000@g.us_AAA',
    from: '12345-1600000000@g.us',
    participant: '521777@c.us',
    fromMe: false,
    body: 'hola a todos',
    _data: { pushName: 'Beto', key: { remoteJid: '12345-1600000000@g.us' } },
  }),
);
assert.strictEqual(grupo[0].messages.length, 1, 'un grupo SÍ genera mensaje');
const gm = grupo[0].messages[0];
assert.strictEqual(gm.from, '12345-1600000000@g.us', 'el contacto es el grupo');
assert.strictEqual(gm.isGroup, true);
// El autor va en el payload, no como columna.
assert.deepStrictEqual((gm.payload as any).author, { waId: '521777@c.us', name: 'Beto' });
// El pushName del participante NO debe pisar el nombre del grupo.
assert.strictEqual(gm.contactName, null);
// Ni se le atribuye al grupo el teléfono de nadie.
assert.ok(!('phone' in gm));

// CONTRAPRUEBA CATASTRÓFICA: un grupo NUNCA debe llevar `phone`, ni aunque el payload
// traiga un `remoteJidAlt`. Si lo llevara, `resolveContact` podría fusionar el hilo
// del GRUPO con la conversación privada de ese miembro — una conversación privada
// convertida en la del grupo.
const grupoConAlt = decodeWebhook(
  wahaEnvelope('message', {
    id: 'gAlt',
    from: '12345-1600000000@g.us',
    participant: '521777@c.us',
    body: 'x',
    _data: {
      key: {
        remoteJid: '12345-1600000000@g.us',
        participant: '521777@c.us',
        remoteJidAlt: '5218715172350@s.whatsapp.net',
      },
    },
  }),
)[0].messages[0];
assert.ok(!('phone' in grupoConAlt), 'un grupo NO puede llevar teléfono');
assert.strictEqual(grupoConAlt.isGroup, true);

// El autor también sale de `_data.key.participant` cuando no viene en la raíz.
assert.deepStrictEqual(
  (
    decodeWebhook(
      wahaEnvelope('message', {
        id: 'g2',
        from: '999-1@g.us',
        body: 'x',
        _data: { key: { participant: '521888@c.us' } },
      }),
    )[0].messages[0].payload as any
  ).author,
  { waId: '521888@c.us' },
);

// En un chat 1-a-1 no hay autor ni isGroup: los campos se OMITEN.
const directo = decodeWebhook(
  wahaEnvelope('message', { id: 'd1', from: '521555@c.us', body: 'x' }),
)[0].messages[0];
assert.ok(!('isGroup' in directo));
assert.ok(!('author' in (directo.payload as any)));

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

// El teléfono real sale de `_data.key.remoteJidAlt` (con LID el id no es un número).
assert.strictEqual(lidReal[0].messages[0].phone, '5218715172350');
// Un entrante NO lleva direction: el processor lo trata como 'in' por defecto.
assert.ok(!('direction' in lidReal[0].messages[0]), 'direction debe OMITIRSE en entrantes');

// --- message.any: el eco de lo que el DUEÑO manda desde su propio teléfono ---
// Forma real del engine NOWEB: `to` llega VACÍO, así que el chat hay que sacarlo
// de `_data.key.remoteJid`. Si se confiara en `to`, el eco se perdería.
const echo = decodeWebhook(
  wahaEnvelope('message.any', {
    id: 'true_175647100039313@lid_BBB',
    from: '5215550000@c.us', // el propio número emparejado, NO el interlocutor
    fromMe: true,
    to: '',
    body: 'te confirmo por aquí',
    hasMedia: false,
    ack: 2,
    _data: {
      pushName: 'Angel Alarcon', // el nombre del DUEÑO: no debe pisar el del contacto
      key: { fromMe: true, remoteJid: '175647100039313@lid', addressingMode: 'lid' },
    },
  }),
);
assert.strictEqual(echo[0].messages.length, 1, 'el eco propio debe entrar');
assert.strictEqual(echo[0].messages[0].direction, 'out');
assert.strictEqual(echo[0].messages[0].from, '175647100039313@lid', 'el chat sale de remoteJid');
assert.strictEqual((echo[0].messages[0].payload as any).viaDevice, true);
assert.strictEqual((echo[0].messages[0].payload as any).text.body, 'te confirmo por aquí');
// El estado inicial sale del ack (2 = entregado), no de un 'sent' fijo.
assert.strictEqual(echo[0].messages[0].status, 'delivered');
// El pushName de un eco es el del dueño: no se usa como nombre del contacto.
assert.strictEqual(echo[0].messages[0].contactName, null);

// Un entrante por `message.any` se decodifica igual que por `message`.
const anyIn = wahaEnvelope('message.any', {
  id: 'in1',
  from: '521555@c.us',
  fromMe: false,
  body: 'hola',
  _data: { pushName: 'Ana' },
});
assert.strictEqual(decodeWebhook(anyIn)[0].messages.length, 1);
assert.strictEqual(decodeWebhook(anyIn)[0].messages[0].contactName, 'Ana');
assert.ok(!('viaDevice' in (decodeWebhook(anyIn)[0].messages[0].payload as any)));
assert.ok(!('direction' in decodeWebhook(anyIn)[0].messages[0]));

// Un eco hacia un CANAL se sigue descartando (no es una conversación atendible).
assert.deepStrictEqual(
  decodeWebhook(
    wahaEnvelope('message.any', {
      id: 'n',
      fromMe: true,
      body: 'x',
      _data: { key: { remoteJid: '999@newsletter' } },
    }),
  )[0].messages,
  [],
);
// Pero un eco hacia un GRUPO sí entra: lo que el dueño escribe en un grupo desde su
// teléfono también tiene que verse en la bandeja.
const ecoGrupo = decodeWebhook(
  wahaEnvelope('message.any', {
    id: 'true_123-1@g.us_X',
    fromMe: true,
    body: 'ahí les va',
    _data: { key: { remoteJid: '123-1@g.us' } },
  }),
)[0].messages;
assert.strictEqual(ecoGrupo.length, 1);
assert.strictEqual(ecoGrupo[0].direction, 'out');
assert.strictEqual(ecoGrupo[0].isGroup, true);

// `@s.whatsapp.net` también es un chat directo.
assert.strictEqual(
  decodeWebhook(wahaEnvelope('message', { id: 'w1', from: '521871@s.whatsapp.net', body: 'x' }))[0]
    .messages.length,
  1,
);
// Un eco con LID también entra, y el chat sale de `from` cuando no hay
// `_data.key.remoteJid` ni `to`.
const lidEcho = decodeWebhook(
  wahaEnvelope('message', { id: 'e', from: '111@lid', fromMe: true, body: 'x' }),
);
assert.strictEqual(lidEcho[0].messages.length, 1);
assert.strictEqual(lidEcho[0].messages[0].from, '111@lid');
assert.strictEqual(lidEcho[0].messages[0].direction, 'out');

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

// --- Reacciones entrantes ---
const react = decodeWebhook(
  wahaEnvelope('message.reaction', {
    id: 'reactEvt',
    from: '521555@c.us',
    reaction: { text: '🙏', messageId: 'false_521555@c.us_AAA' },
    _data: { key: { remoteJid: '521555@c.us' } },
  }),
);
// Apunta al mensaje ORIGINAL, no crea uno nuevo.
assert.deepStrictEqual(react[0].messages, []);
assert.deepStrictEqual(react[0].mutations, [
  { kind: 'reaction', wamid: 'false_521555@c.us_AAA', author: '521555@c.us', emoji: '🙏' },
]);
// NUESTRA propia reacción se normaliza a 'me', el mismo autor que usa la escritura
// optimista al reaccionar desde la bandeja. Si no, la misma reacción se contaba dos
// veces: una como 'me' y otra con el jid (bug observado en uso real).
assert.deepStrictEqual(
  decodeWebhook(
    wahaEnvelope('message.reaction', {
      fromMe: true,
      from: '5218716458297@c.us',
      reaction: { text: '😂', messageId: 'm1' },
      _data: { key: { remoteJid: '5218716458297@c.us' } },
    }),
  )[0].mutations,
  [{ kind: 'reaction', wamid: 'm1', author: 'me', emoji: '😂' }],
);

// Texto vacío = quitó la reacción (no es "sin reacción").
assert.deepStrictEqual(
  decodeWebhook(
    wahaEnvelope('message.reaction', {
      from: '521555@c.us',
      reaction: { text: '', messageId: 'm1' },
    }),
  )[0].mutations,
  [{ kind: 'reaction', wamid: 'm1', author: '521555@c.us', emoji: '' }],
);
// Sin messageId no hay nada que parchear.
assert.strictEqual(
  decodeWebhook(wahaEnvelope('message.reaction', { from: 'x@c.us', reaction: { text: '👍' } }))[0]
    .mutations,
  undefined,
);

// --- Borrados ---
// El id del mensaje afectado va en `before.id`; el payload NO tiene `id` en la
// raíz, así que buscarlo ahí dejaría el parcheo sin efecto EN SILENCIO.
const revoked = decodeWebhook(
  wahaEnvelope('message.revoked', {
    before: { id: 'false_521555@c.us_BBB', timestamp: 1741249702, body: 'me equivoqué' },
    after: { id: 'false_521555@c.us_BBB', timestamp: 1741249800, body: '' },
  }),
);
assert.deepStrictEqual(revoked[0].mutations, [
  { kind: 'revoked', wamid: 'false_521555@c.us_BBB' },
]);
assert.deepStrictEqual(revoked[0].messages, []);
// Sin `before` no se inventa un objetivo.
assert.strictEqual(decodeWebhook(wahaEnvelope('message.revoked', {}))[0].mutations, undefined);
assert.strictEqual(
  decodeWebhook(wahaEnvelope('message.revoked', { after: { id: 'x' } }))[0].mutations,
  undefined,
);

// --- Editados: suscrito pero SIN decodificar todavía ---
// WAHA no publica el payload de este evento. Aterriza para poder capturar su forma
// real; escribir un decoder a ciegas guardaría datos mal en silencio (lección @lid).
const edited = decodeWebhook(wahaEnvelope('message.edited', { lo: 'que sea' }));
assert.strictEqual(edited.length, 1, 'debe aterrizar como ok, no descartarse');
assert.deepStrictEqual(edited[0].messages, []);
assert.strictEqual(edited[0].mutations, undefined);
// Y con payload ausente tampoco lanza.
assert.doesNotThrow(() => decodeWebhook(wahaEnvelope('message.edited', undefined as any)));

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
