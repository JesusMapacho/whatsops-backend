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

// Los canales de Meta SÍ aplican la ventana de 24 h y usan la forma de Meta para
// el id del mensaje (sin messageId propio). Regresión de la feature 26.
assert.ok(wa.enforcesWindow && msn.enforcesWindow);
assert.strictEqual(wa.messageId, undefined);
assert.strictEqual(msn.messageId, undefined);
assert.ok(!wa.mediaAsBase64 && !msn.mediaAsBase64);
assert.strictEqual(wa.authHeaders('TOK').Authorization, 'Bearer TOK');

// --- WAHA: rutas fijas por tipo, sesión en el cuerpo, sin ventana ni plantillas ---
const waha = channelAdapter('waha');
const B = 'http://localhost:3002';

assert.strictEqual(waha.sendUrl('t_x', 'v22.0', B), `${B}/api/sendText`);
assert.strictEqual(waha.sendUrl('t_x', 'v22.0', B, 'image'), `${B}/api/sendImage`);
assert.strictEqual(waha.sendUrl('t_x', 'v22.0', B, 'sticker'), `${B}/api/sendImage`);
assert.strictEqual(waha.sendUrl('t_x', 'v22.0', B, 'video'), `${B}/api/sendVideo`);
assert.strictEqual(waha.sendUrl('t_x', 'v22.0', B, 'audio'), `${B}/api/sendFile`);
// El audio se bifurca por MIME: solo ogg/webm salen como NOTA de voz. Antes todo
// iba por sendFile y llegaba al teléfono como archivo adjunto.
assert.strictEqual(
  waha.sendUrl('t_x', 'v22.0', B, 'audio', 'audio/ogg; codecs=opus'),
  `${B}/api/sendVoice`,
);
assert.strictEqual(waha.sendUrl('t_x', 'v22.0', B, 'audio', 'audio/webm'), `${B}/api/sendVoice`);
assert.strictEqual(waha.sendUrl('t_x', 'v22.0', B, 'audio', 'audio/mpeg'), `${B}/api/sendFile`);
// Y solo el audio: una imagen no se convierte en nota de voz por el mime.
assert.strictEqual(waha.sendUrl('t_x', 'v22.0', B, 'image', 'audio/ogg'), `${B}/api/sendImage`);
assert.strictEqual(waha.sendUrl('t_x', 'v22.0', B, 'document'), `${B}/api/sendFile`);
// Barra final en la base no duplica la del path.
assert.strictEqual(waha.sendUrl('t_x', 'v22.0', `${B}/`), `${B}/api/sendText`);

assert.ok(!waha.supportsTemplate && !waha.needsMediaUpload);
assert.ok(!waha.enforcesWindow, 'WAHA no es Meta: no hay ventana de 24 h');
assert.ok(waha.mediaAsBase64);
assert.deepStrictEqual(waha.authHeaders('KEY'), {
  'X-Api-Key': 'KEY',
  'Content-Type': 'application/json',
});

// Texto: la sesión viaja en el cuerpo, el destinatario es el chatId completo.
assert.deepStrictEqual(waha.buildText('521555@c.us', { type: 'text', text: 'hola' }, 't_x'), {
  session: 't_x',
  chatId: '521555@c.us',
  text: 'hola',
});
// Las plantillas son de Meta: lanza.
assert.throws(() =>
  waha.buildText('521555@c.us', { type: 'template', name: 'x', language: 'es' } as any, 't_x'),
);

// Media inline en base64 (no por URL: WAHA no alcanzaría nuestro localhost).
const wahaMedia = waha.buildMedia(
  '521555@c.us',
  'image',
  'QkFTRTY0',
  { caption: 'mira', mimeType: 'image/jpeg', filename: 'x.jpg' },
  't_x',
) as any;
assert.strictEqual(wahaMedia.session, 't_x');
assert.strictEqual(wahaMedia.chatId, '521555@c.us');
assert.strictEqual(wahaMedia.file.data, 'QkFTRTY0');
assert.strictEqual(wahaMedia.file.mimetype, 'image/jpeg');
assert.strictEqual(wahaMedia.file.filename, 'x.jpg');
assert.strictEqual(wahaMedia.caption, 'mira');
// sticker y audio no llevan caption, igual que en Cloud API.
assert.strictEqual(
  (waha.buildMedia('5@c.us', 'sticker', 'B64', { caption: 'x', mimeType: 'image/webp' }, 't') as any).caption,
  undefined,
);
assert.strictEqual(
  (waha.buildMedia('5@c.us', 'audio', 'B64', { caption: 'x', mimeType: 'audio/ogg' }, 't') as any).caption,
  undefined,
);

// El id del mensaje: string en unos engines, { _serialized } en otros. Sin esto
// `wamid` quedaría nulo y los acuses nunca cuadrarían.
assert.strictEqual(waha.messageId!({ id: 'false_5@c.us_AAA' }), 'false_5@c.us_AAA');
assert.strictEqual(waha.messageId!({ id: { _serialized: 'X' } }), 'X');
assert.strictEqual(waha.messageId!({ _data: { id: { _serialized: 'Y' } } }), 'Y');
assert.strictEqual(waha.messageId!({}), null);
assert.strictEqual(waha.messageId!(null), null);

// NOWEB/GOWS devuelven la forma de Baileys: hay que RE-SERIALIZAR la clave para que
// el id case con el del evento message.any. Sin esto el wamid quedaba nulo y CADA
// mensaje enviado aparecía dos veces en el hilo (bug observado en uso real).
assert.strictEqual(
  waha.messageId!({ key: { fromMe: true, remoteJid: '240183328899228@lid', id: '3EB0294C08' } }),
  'true_240183328899228@lid_3EB0294C08',
);
assert.strictEqual(
  waha.messageId!({ _data: { key: { fromMe: false, remoteJid: '5215@c.us', id: 'AC45' } } }),
  'false_5215@c.us_AC45',
);
// Una clave incompleta no produce un id inventado.
assert.strictEqual(waha.messageId!({ key: { id: 'solo-id' } }), null);
assert.strictEqual(waha.messageId!({ key: { remoteJid: '5@c.us' } }), null);
// Y el formato debe coincidir EXACTAMENTE con el que emite el decoder para un eco.
assert.strictEqual(
  waha.messageId!({ key: { fromMe: true, remoteJid: '5@c.us', id: 'Z' } }),
  'true_5@c.us_Z',
);

// Errores de WAHA: `message` puede ser string o array de validación.
assert.strictEqual(waha.mapError({ message: 'boom' }), 'boom');
assert.strictEqual(waha.mapError({ message: ['a', 'b'] }), 'a; b');
assert.strictEqual(waha.mapError({}), 'WAHA rechazó el envío.');

// --- Citas: cada canal la nombra distinto ---
assert.strictEqual(
  (waha.buildText('5@c.us', { type: 'text', text: 'x', replyTo: 'W1' }, 't') as any).reply_to,
  'W1',
);
assert.deepStrictEqual(
  (wa.buildText('521555', { type: 'text', text: 'x', replyTo: 'W1' }) as any).context,
  { message_id: 'W1' },
);
assert.deepStrictEqual(
  (msn.buildText('PSID', { type: 'text', text: 'x', replyTo: 'W1' }) as any).message.reply_to,
  { mid: 'W1' },
);
// Sin cita, el campo se OMITE (no va como undefined).
assert.ok(!('reply_to' in (waha.buildText('5@c.us', { type: 'text', text: 'x' }, 't') as any)));
assert.ok(!('context' in (wa.buildText('521555', { type: 'text', text: 'x' }) as any)));

// --- convert:true solo en notas de voz ---
// WhatsApp exige ogg/opus y el navegador graba webm; WAHA transcodifica si se pide.
assert.strictEqual(
  (waha.buildMedia('5@c.us', 'audio', 'B64', { mimeType: 'audio/webm' }, 't') as any).convert,
  true,
);
assert.strictEqual(
  (waha.buildMedia('5@c.us', 'audio', 'B64', { mimeType: 'audio/mpeg' }, 't') as any).convert,
  undefined,
);
assert.strictEqual(
  (waha.buildMedia('5@c.us', 'image', 'B64', { mimeType: 'image/jpeg' }, 't') as any).convert,
  undefined,
);

// WAHA acepta lo que graba el navegador; los canales de Meta no declaran extras.
assert.deepStrictEqual(waha.extraMimes, ['audio/webm', 'audio/ogg']);
assert.strictEqual(wa.extraMimes, undefined);
assert.strictEqual(msn.extraMimes, undefined);

// --- Escribir primero (feature 29) ---
// En Messenger/IG es IMPOSIBLE, no difícil: de un teléfono no se deriva un PSID ni
// un IGSID, y este adaptador tampoco soporta plantillas. Que sea una capacidad y no
// un `if (platform === ...)` es lo que impide que alguien lo "arregle" con un caso
// especial en el servicio.
assert.strictEqual(msn.supportsColdOutreach, false);
assert.strictEqual(ig.supportsColdOutreach, false);
assert.strictEqual(wa.supportsColdOutreach, true, 'Cloud API con plantilla es justo lo que Meta permite');
assert.strictEqual(waha.supportsColdOutreach, true);
// Y el que no tiene ventana es el único al que los topes en frío contienen de verdad.
assert.ok(waha.paced && !waha.enforcesWindow);

// --- Estados / historias (feature 29 fase 7) ---
// Ventaja real del canal por QR: la API oficial de Meta NO puede publicar estados
// (el Cloud API es de mensajería; los estados son función de consumidor).
assert.strictEqual(waha.supportsStatus, true);
assert.ok(!wa.supportsStatus, 'Cloud API no puede publicar estados');
assert.ok(!msn.supportsStatus);
// Y en NOWEB se publica pero NO se borra: un estado equivocado se queda sus 24 h.
// La UI lo avisa ANTES de publicar en vez de ofrecer un botón que no existe.
assert.strictEqual(waha.supportsStatusDelete, false);

console.log('channels.check OK');
