// Adaptadores de ENVÍO por canal. Objetos planos (sin clases/factory): el esqueleto
// de MessagingService (validar→cargar→ventana→payload→POST→persistir) delega aquí lo
// que difiere entre WhatsApp y Messenger/Instagram: URL, forma del payload, soporte de
// plantillas, si el media se sube (WA) o se referencia por URL (messaging), y el error.
import { Platform } from '@prisma/client';
import { SendDto, buildMessagePayload, mapGraphError } from './messaging.util';
import { buildMediaPayload, isVoiceMime, MediaKind } from './media.util';

// Opciones del media al construir el cuerpo. `mimeType` solo lo usa WAHA (manda el
// binario inline y tiene que declarar el tipo); los adaptadores de Meta lo ignoran.
export interface MediaOpts {
  caption?: string;
  filename?: string;
  mimeType?: string;
  // wamid del mensaje que se está citando.
  replyTo?: string;
}

export interface ChannelAdapter {
  // WhatsApp acepta plantillas; Messenger/IG no (usan message tags, fuera de alcance).
  supportsTemplate: boolean;
  // WA sube el binario a /media y referencia por id; Messenger/IG referencian por URL.
  needsMediaUpload: boolean;
  // La ventana de servicio de 24 h es una regla de Meta: WAHA (WhatsApp Web) no la tiene.
  enforcesWindow: boolean;
  // WAHA manda el binario inline en base64 en vez de referenciarlo por URL.
  mediaAsBase64?: boolean;
  // El transporte no oficial arriesga el número del tenant: se le aplica ritmo y
  // cupo (ver limits.ts). Los canales de Meta ya los limita Meta.
  paced?: boolean;
  // ¿Se puede escribir a un número que nunca nos escribió?
  //
  // Messenger/Instagram: NO, y es imposible, no difícil — de un teléfono no se deriva
  // un PSID/IGSID, y este adaptador tampoco soporta plantillas. Rechazarlo aquí evita
  // crear una conversación que jamás podría enviar nada.
  supportsColdOutreach: boolean;
  // ¿Se pueden publicar estados (las "historias" de WhatsApp)?
  //
  // Ventaja real del canal por QR: la API oficial de Meta **no puede hacerlo**. El
  // Cloud API es de mensajería y los estados son función de consumidor, no expuesta.
  // Que los únicos que lo ofrecen sean también no oficiales lo confirma.
  supportsStatus?: boolean;
  // ¿Se puede BORRAR un estado publicado? En NOWEB (el engine que usamos) no: es
  // solo WEBJS/WPP. Un estado equivocado se queda sus 24 h, y la UI tiene que
  // avisarlo ANTES de publicar, no ofrecer un botón que no existe.
  supportsStatusDelete?: boolean;
  // MIMEs que este canal acepta ADEMÁS de la lista blanca de la Cloud API
  // (MEDIA_LIMITS). WAHA transcodifica con ffmpeg, así que traga lo que graba el
  // navegador; la lista de Meta no se ensancha por ello.
  extraMimes?: string[];
  windowClosedMessage: string;
  // baseUrl, kind y mime solo los usa WAHA (rutas fijas por tipo); version solo Meta.
  sendUrl(
    externalId: string,
    version: string,
    baseUrl?: string,
    kind?: MediaKind,
    mime?: string,
  ): string;
  authHeaders(token: string): Record<string, string>;
  // session solo lo usa WAHA: viaja en el cuerpo, no en la URL.
  buildText(to: string, dto: SendDto, session?: string): object;
  // ref = mediaId (WA) | URL pública del binario (Messenger/IG) | base64 (WAHA).
  buildMedia(
    to: string,
    kind: MediaKind,
    ref: string,
    opts: MediaOpts,
    session?: string,
  ): object;
  // Extrae el id del mensaje de la respuesta. Sin definir ⇒ la forma de Meta
  // (`json.messages[0].id`), que resuelve MessagingService.
  messageId?(json: any): string | null;
  mapError(json: any): string;
}

function messagesUrl(externalId: string, version: string): string {
  return `https://graph.facebook.com/${version}/${encodeURIComponent(externalId)}/messages`;
}

const bearer = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

const whatsapp: ChannelAdapter = {
  supportsTemplate: true,
  needsMediaUpload: true,
  enforcesWindow: true,
  // Con plantilla aprobada: es justo lo que Meta permite para iniciar.
  supportsColdOutreach: true,
  windowClosedMessage: 'Ventana de 24 h cerrada: solo se permiten mensajes de plantilla.',
  sendUrl: messagesUrl,
  authHeaders: bearer,
  buildText: (to, dto) => buildMessagePayload(to, dto),
  buildMedia: (to, kind, mediaId, opts) => buildMediaPayload(to, kind, mediaId, opts),
  mapError: mapGraphError,
};

// Tipo de adjunto de la Send API de Messenger/IG.
const ATTACHMENT_TYPE: Record<MediaKind, string> = {
  image: 'image',
  sticker: 'image',
  audio: 'audio',
  video: 'video',
  document: 'file',
};

// Messenger (page) e Instagram comparten la Send API: POST /{id}/messages con
// { recipient:{id}, message:{...} }. Sin plantillas.
const messaging: ChannelAdapter = {
  supportsTemplate: false,
  needsMediaUpload: false,
  enforcesWindow: true,
  supportsColdOutreach: false,
  windowClosedMessage:
    'Ventana de 24 h cerrada: este canal no permite iniciar conversación fuera de la ventana.',
  sendUrl: messagesUrl,
  authHeaders: bearer,
  buildText: (to, dto) => {
    if (dto.type !== 'text') throw new Error('Este canal no soporta plantillas');
    return {
      recipient: { id: to },
      messaging_type: 'RESPONSE',
      message: {
        text: dto.text,
        // Cita: en la Send API se llama `reply_to.mid`.
        ...(dto.replyTo ? { reply_to: { mid: dto.replyTo } } : {}),
      },
    };
  },
  buildMedia: (to, kind, url) => ({
    recipient: { id: to },
    message: { attachment: { type: ATTACHMENT_TYPE[kind], payload: { url, is_reusable: true } } },
  }),
  mapError: (json) => json?.error?.message ?? 'Meta rechazó el envío.',
};

// WAHA no tiene un endpoint único: hay una ruta fija por tipo de mensaje, y el
// destinatario y la sesión viajan en el cuerpo.
const WAHA_PATH: Record<MediaKind | 'text', string> = {
  text: 'sendText',
  image: 'sendImage',
  sticker: 'sendImage',
  // Un audio genérico (mp3, aac) va como adjunto; solo ogg/webm salen como NOTA
  // de voz por /api/sendVoice — ver wahaSendPath.
  audio: 'sendFile',
  video: 'sendVideo',
  document: 'sendFile',
};

// Extrae el id de un mensaje de la respuesta de envío de WAHA, probando las formas
// conocidas. Devuelve null si ninguna encaja (quien llama lo registra).
export function wahaMessageId(json: any): string | null {
  // 1) Ya serializado como string: 'true_5215555@c.us_3EB0…'
  if (typeof json?.id === 'string' && json.id) return json.id;
  // 2) WEBJS/WPP: { id: { _serialized } }
  if (typeof json?.id?._serialized === 'string') return json.id._serialized;
  if (typeof json?._data?.id?._serialized === 'string') return json._data.id._serialized;
  // 3) NOWEB/GOWS (Baileys): { key: { remoteJid, fromMe, id } } → hay que
  //    re-serializarlo igual que lo hace el evento, o los ids no casan.
  const key = json?.key ?? json?._data?.key;
  if (key && typeof key.id === 'string' && typeof key.remoteJid === 'string') {
    return `${key.fromMe ? 'true' : 'false'}_${key.remoteJid}_${key.id}`;
  }
  return null;
}

// Ruta de envío de WAHA. El audio se bifurca por MIME: enviarlo todo por sendFile
// hacía que una nota de voz llegara al teléfono como archivo adjunto en vez de
// burbuja reproducible.
function wahaSendPath(kind: MediaKind | 'text', mime?: string): string {
  if (kind === 'audio' && mime && isVoiceMime(mime)) return 'sendVoice';
  return WAHA_PATH[kind];
}

// WAHA (https://waha.devlike.pro): WhatsApp Web self-hosted. No es API de Meta,
// así que no hay ventana de 24 h ni plantillas. Auth por X-Api-Key de instancia.
const waha: ChannelAdapter = {
  supportsTemplate: false,
  needsMediaUpload: false,
  enforcesWindow: false,
  mediaAsBase64: true,
  paced: true,
  // Técnicamente sí, y por eso los topes en frío son lo único que lo contiene: aquí
  // no hay ventana ni plantillas que obliguen a nada.
  supportsColdOutreach: true,
  supportsStatus: true,
  // NOWEB publica pero NO borra (borrar es solo WEBJS/WPP). Si algún día se cambia
  // de engine, esta línea es lo único que hay que tocar.
  supportsStatusDelete: false,
  // WAHA transcodifica con ffmpeg, así que acepta lo que graba el navegador
  // (Chrome/Edge dan audio/webm; Safari audio/mp4).
  extraMimes: ['audio/webm', 'audio/ogg'],
  windowClosedMessage: '', // nunca se usa: enforcesWindow es false
  // El primer argumento (id externo) se ignora: la sesión va en el cuerpo.
  sendUrl: (_externalId, _version, baseUrl = '', kind, mime) =>
    `${baseUrl.replace(/\/$/, '')}/api/${wahaSendPath(kind ?? 'text', mime)}`,
  authHeaders: (apiKey) => ({ 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }),
  buildText: (chatId, dto, session) => {
    if (dto.type !== 'text') throw new Error('WAHA no soporta plantillas de Meta');
    return {
      session,
      chatId,
      text: dto.text,
      ...(dto.replyTo ? { reply_to: dto.replyTo } : {}),
    };
  },
  buildMedia: (chatId, kind, dataB64, opts, session) => ({
    session,
    chatId,
    file: {
      mimetype: opts.mimeType ?? 'application/octet-stream',
      data: dataB64,
      filename: opts.filename ?? 'file',
    },
    // sticker y audio no llevan caption, igual que en Cloud API.
    ...(opts.caption && kind !== 'sticker' && kind !== 'audio'
      ? { caption: opts.caption }
      : {}),
    // Notas de voz: WhatsApp exige ogg/opus, y el navegador graba webm. WAHA lo
    // transcodifica con ffmpeg si se le pide (verificado en la imagen `noweb`).
    ...(kind === 'audio' && opts.mimeType && isVoiceMime(opts.mimeType)
      ? { convert: true }
      : {}),
    ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
  }),
  // Id del mensaje enviado. La forma varía por engine y NO está documentada, así
  // que se cubren todas las plausibles.
  //
  // Es crítico: con `wamid` nulo, el eco de `message.any` no puede deduplicarse y
  // CADA mensaje enviado aparecía dos veces en el hilo (bug observado en uso real).
  // El engine NOWEB devuelve la forma de Baileys (`key.id`), que hay que
  // re-serializar como `${fromMe}_${remoteJid}_${id}` para que case con el id del eco.
  messageId: wahaMessageId,
  mapError: (json) => {
    const m = json?.message;
    return (Array.isArray(m) ? m.join('; ') : m) ?? 'WAHA rechazó el envío.';
  },
};

const ADAPTERS: Record<Platform, ChannelAdapter> = {
  whatsapp,
  messenger: messaging,
  instagram: messaging,
  waha,
};

export function channelAdapter(platform: Platform): ChannelAdapter {
  return ADAPTERS[platform] ?? whatsapp;
}
