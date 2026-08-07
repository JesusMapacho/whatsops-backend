// Función pura: aplana el payload del proveedor a una lista de cambios
// normalizados. Sin DB ni efectos → testeable en aislamiento (ver decode.check.ts).
// Enruta a un decoder por canal; todos emiten la misma forma.

import { MessageStatus } from '@prisma/client';
import { kindForMime } from '../messaging/media.util';
import { ACK_STATUS } from './waha';

export type Platform = 'whatsapp' | 'instagram' | 'messenger' | 'waha';

// OJO al añadir campos: decode.check.ts compara con deepStrictEqual, y en Node
// `{a:1, b:undefined}` NO es igual a `{a:1}`. Los opcionales deben OMITIRSE.
export interface InboundMessage {
  wamid: string; // id del mensaje del canal (wamid en WA, mid en Messenger/IG, id en WAHA)
  from: string; // id externo del contacto (wa_id / PSID / IGSID / chatId '@c.us')
  type: string;
  payload: unknown; // objeto crudo del mensaje
  contactName: string | null;
  // 'out' = eco de lo que el dueño mandó desde su propio teléfono. Ausente ⇒ 'in'.
  direction?: 'in' | 'out';
  // Estado inicial de un eco (sale del ack). Los entrantes van a 'delivered'.
  status?: MessageStatus;
  // Teléfono real en dígitos cuando el id del canal no lo es (LID addressing).
  phone?: string;
  // El chat es un grupo: el autor concreto va en `payload.author`.
  isGroup?: boolean;
}

export interface StatusUpdate {
  wamid: string;
  status: MessageStatus;
}

export interface NormalizedChange {
  platform: Platform;
  channelRef: string | null; // phone_number_id (WA) / page id (Messenger) / IG id / sesión (WAHA)
  messages: InboundMessage[];
  statuses: StatusUpdate[];
  // Estado vivo de la sesión (solo WAHA): el worker lo refleja en WabaConnection.status.
  sessionStatus?: string;
}

export function decodeWebhook(payload: any): NormalizedChange[] {
  // WAHA antes del switch: su envelope no trae `object`, así que caería en el
  // `default` de WhatsApp y se decodificaría a nada, en silencio.
  if (typeof payload?.event === 'string' && typeof payload?.session === 'string') {
    return decodeWaha(payload);
  }
  switch (payload?.object) {
    case 'page':
      return decodeMessaging(payload, 'messenger');
    case 'instagram':
      return decodeMessaging(payload, 'instagram');
    // whatsapp_business_account o ausente (compat) → WhatsApp.
    default:
      return decodeWhatsApp(payload);
  }
}

// --- WhatsApp Cloud API: entry[].changes[].value.{messages,statuses,contacts,metadata} ---
function decodeWhatsApp(payload: any): NormalizedChange[] {
  const out: NormalizedChange[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      const nameByWaId = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c?.wa_id && c?.profile?.name) nameByWaId.set(c.wa_id, c.profile.name);
      }
      out.push({
        platform: 'whatsapp',
        channelRef: value.metadata?.phone_number_id ?? null,
        messages: (value.messages ?? [])
          .filter((m: any) => m?.id && m?.from)
          .map((m: any) => ({
            wamid: m.id,
            from: m.from,
            type: m.type ?? 'unknown',
            payload: m,
            contactName: nameByWaId.get(m.from) ?? null,
          })),
        statuses: (value.statuses ?? [])
          .filter((s: any) => s?.id && asStatus(s.status))
          .map((s: any) => ({ wamid: s.id, status: asStatus(s.status)! })),
      });
    }
  }
  return out;
}

// Tipos de adjunto de Messenger/IG → nuestros tipos internos.
const ATTACHMENT_TYPE: Record<string, string> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  file: 'document',
};

// --- Messenger (object:'page') e Instagram (object:'instagram'): entry[].messaging[] ---
// Misma forma para ambos: sender.id (PSID/IGSID), message.mid, message.text/attachments[].
function decodeMessaging(payload: any, platform: Platform): NormalizedChange[] {
  const out: NormalizedChange[] = [];
  for (const entry of payload?.entry ?? []) {
    const channelRef = entry?.id ?? null; // page id / IG account id
    const messages: InboundMessage[] = [];
    const statuses: StatusUpdate[] = [];
    for (const ev of entry?.messaging ?? []) {
      const from = ev?.sender?.id;
      if (ev?.message?.mid && from) {
        const m = ev.message;
        const att = Array.isArray(m.attachments) ? m.attachments[0] : null;
        const type = att ? (ATTACHMENT_TYPE[att.type] ?? 'unknown') : 'text';
        messages.push({ wamid: m.mid, from, type, payload: m, contactName: null });
      }
      // Acuses de entrega: delivery.mids[] → 'delivered'. (read usa watermark sin mid → se omite.)
      for (const mid of ev?.delivery?.mids ?? []) {
        statuses.push({ wamid: mid, status: 'delivered' });
      }
    }
    out.push({ platform, channelRef, messages, statuses });
  }
  return out;
}

const STATUSES = new Set<string>(['sent', 'delivered', 'read', 'failed']);

// Valida un estado que llega de fuera contra el enum de Prisma. Un valor ajeno
// reventaría al persistir, así que se descarta en la frontera.
function asStatus(v: unknown): MessageStatus | null {
  return typeof v === 'string' && STATUSES.has(v) ? (v as MessageStatus) : null;
}

// Sufijos de chat que NO son una conversación 1-a-1: grupos, canales y los
// estados/difusión (`status@broadcast`). Todo lo demás se acepta como directo:
// además de `@c.us` hay `@lid` (LID addressing, lo que usa WhatsApp moderno con
// multi-dispositivo) y `@s.whatsapp.net`.
//
// Es una lista NEGRA a propósito, no blanca: descartar en silencio el mensaje de
// un cliente real es el peor fallo posible de este producto, mientras que colar
// una conversación basura es visible y se borra. Con lista blanca de `@c.us` los
// mensajes con LID se perdían sin dejar rastro.
const NOT_DIRECT = ['@g.us', '@newsletter', '@broadcast'];

function isDirectChat(from: string): boolean {
  return !!from && !NOT_DIRECT.some((s) => from.endsWith(s));
}

// Un mensaje de WAHA (entrante o eco propio) → forma interna. `null` si no
// aporta: sin id, o de un chat que no es 1-a-1.
function decodeWahaMessage(payload: any): InboundMessage | null {
  const key = payload._data?.key ?? {};
  // Para un eco propio, `from` NO es el interlocutor. `_data.key.remoteJid` es
  // siempre el chat; `to` es el respaldo (en el engine NOWEB llega como '', que
  // es falsy, así que el orden importa de verdad).
  const chat: string = payload.fromMe
    ? key.remoteJid || payload.to || payload.from || ''
    : payload.from || '';
  if (!payload.id || !isDirectChat(chat)) return null;

  const mime: string | undefined = payload.media?.mimetype;
  const type = payload.hasMedia && mime ? kindForMime(mime) : 'text';
  // Con LID addressing el chat no es un número; el teléfono real viene aparte.
  const phone = digitsOf(key.remoteJidAlt);

  return {
    wamid: payload.id,
    from: chat,
    type,
    payload: {
      ...payload,
      // Normalizamos el texto a la forma de Meta (`text.body`) para que el hilo
      // de la bandeja lo pinte sin cambios en el frontend.
      text: { body: payload.body ?? '' },
      // Marca el eco para el badge de la burbuja y —importante— para excluirlo
      // del ritmo por contacto (ver limits.ts).
      ...(payload.fromMe ? { viaDevice: true } : {}),
    },
    // El engine NOWEB lo manda como `_data.pushName`; otros como `notifyName`.
    // Sin esto el contacto queda sin nombre y el agente solo ve un id (que con
    // LID no es ni un teléfono). En un eco el pushName es el del DUEÑO, no el
    // del interlocutor: no se usa.
    contactName: payload.fromMe
      ? null
      : (payload._data?.pushName ?? payload._data?.notifyName ?? payload.notifyName ?? null),
    ...(payload.fromMe ? { direction: 'out' as const } : {}),
    ...(payload.fromMe ? { status: ACK_STATUS[Number(payload.ack)] ?? 'sent' } : {}),
    ...(phone ? { phone } : {}),
  };
}

// '5218715172350@s.whatsapp.net' → '5218715172350'. Vacío si no hay dígitos.
function digitsOf(jid: unknown): string | undefined {
  if (typeof jid !== 'string') return undefined;
  const d = jid.split('@')[0].replace(/\D/g, '');
  return d || undefined;
}

// --- WAHA: { event, session, payload } (envelope propio, no de Meta) ---
// Un solo cambio por POST: WAHA manda un evento por request.
function decodeWaha(p: any): NormalizedChange[] {
  const base = { platform: 'waha' as const, channelRef: p.session ?? null };
  const payload = p.payload ?? {};

  switch (p.event) {
    // `message` = solo entrantes. `message.any` = además lo que el DUEÑO manda
    // desde su propio teléfono, que es como la bandeja se entera de esas
    // respuestas (si no, el agente ve una conversación "sin contestar" que ya se
    // contestó desde el celular). Ambos comparten forma de payload.
    case 'message':
    case 'message.any': {
      const msg = decodeWahaMessage(payload);
      return [{ ...base, messages: msg ? [msg] : [], statuses: [] }];
    }
    case 'message.ack': {
      const status = ACK_STATUS[Number(payload.ack)];
      // Solo interesan los acuses de NUESTROS salientes; un ack desconocido se ignora.
      const relevant = payload.fromMe && payload.id && status;
      return [
        {
          ...base,
          messages: [],
          statuses: relevant ? [{ wamid: payload.id, status }] : [],
        },
      ];
    }
    case 'session.status':
      return [
        {
          ...base,
          messages: [],
          statuses: [],
          ...(typeof payload.status === 'string' ? { sessionStatus: payload.status } : {}),
        },
      ];
    // Evento al que no estamos suscritos: no es un error, simplemente no aporta.
    default:
      return [];
  }
}

// El tipo del WebhookEvent: `event` en WAHA, field de WhatsApp, u `object` para IG/Messenger.
export function webhookType(payload: any): string {
  if (typeof payload?.event === 'string') return payload.event;
  if (payload?.object === 'page' || payload?.object === 'instagram') return payload.object;
  return payload?.entry?.[0]?.changes?.[0]?.field ?? 'unknown';
}
