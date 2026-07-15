// Adaptadores de ENVÍO por canal. Objetos planos (sin clases/factory): el esqueleto
// de MessagingService (validar→cargar→ventana→payload→POST→persistir) delega aquí lo
// que difiere entre WhatsApp y Messenger/Instagram: URL, forma del payload, soporte de
// plantillas, si el media se sube (WA) o se referencia por URL (messaging), y el error.
import { Platform } from '@prisma/client';
import { SendDto, buildMessagePayload, mapGraphError } from './messaging.util';
import { buildMediaPayload, MediaKind } from './media.util';

export interface ChannelAdapter {
  // WhatsApp acepta plantillas; Messenger/IG no (usan message tags, fuera de alcance).
  supportsTemplate: boolean;
  // WA sube el binario a /media y referencia por id; Messenger/IG referencian por URL.
  needsMediaUpload: boolean;
  windowClosedMessage: string;
  sendUrl(externalId: string, version: string): string;
  buildText(to: string, dto: SendDto): object;
  // ref = mediaId (WA) | URL pública del binario (Messenger/IG).
  buildMedia(to: string, kind: MediaKind, ref: string, opts: { caption?: string; filename?: string }): object;
  mapError(json: any): string;
}

function messagesUrl(externalId: string, version: string): string {
  return `https://graph.facebook.com/${version}/${encodeURIComponent(externalId)}/messages`;
}

const whatsapp: ChannelAdapter = {
  supportsTemplate: true,
  needsMediaUpload: true,
  windowClosedMessage: 'Ventana de 24 h cerrada: solo se permiten mensajes de plantilla.',
  sendUrl: messagesUrl,
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
  windowClosedMessage:
    'Ventana de 24 h cerrada: este canal no permite iniciar conversación fuera de la ventana.',
  sendUrl: messagesUrl,
  buildText: (to, dto) => {
    if (dto.type !== 'text') throw new Error('Este canal no soporta plantillas');
    return { recipient: { id: to }, messaging_type: 'RESPONSE', message: { text: dto.text } };
  },
  buildMedia: (to, kind, url) => ({
    recipient: { id: to },
    message: { attachment: { type: ATTACHMENT_TYPE[kind], payload: { url, is_reusable: true } } },
  }),
  mapError: (json) => json?.error?.message ?? 'Meta rechazó el envío.',
};

const ADAPTERS: Record<Platform, ChannelAdapter> = {
  whatsapp,
  messenger: messaging,
  instagram: messaging,
};

export function channelAdapter(platform: Platform): ChannelAdapter {
  return ADAPTERS[platform] ?? whatsapp;
}
