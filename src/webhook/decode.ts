// Función pura: aplana el payload de Meta a una lista de cambios normalizados.
// Sin DB ni efectos → testeable en aislamiento (ver decode.check.ts).
// Enruta por `payload.object` a un decoder por canal; todos emiten la misma forma.

export type Platform = 'whatsapp' | 'instagram' | 'messenger';

export interface InboundMessage {
  wamid: string; // id del mensaje del canal (wamid en WA, mid en Messenger/IG)
  from: string; // id externo del contacto (wa_id / PSID / IGSID)
  type: string;
  payload: unknown; // objeto crudo del mensaje
  contactName: string | null;
}

export interface StatusUpdate {
  wamid: string;
  status: string; // sent | delivered | read | failed
}

export interface NormalizedChange {
  platform: Platform;
  channelRef: string | null; // phone_number_id (WA) / page id (Messenger) / IG id
  messages: InboundMessage[];
  statuses: StatusUpdate[];
}

export function decodeWebhook(payload: any): NormalizedChange[] {
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
          .filter((s: any) => s?.id && s?.status)
          .map((s: any) => ({ wamid: s.id, status: s.status })),
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

// El tipo del WebhookEvent: field de WhatsApp, u `object` para IG/Messenger.
export function webhookType(payload: any): string {
  if (payload?.object === 'page' || payload?.object === 'instagram') return payload.object;
  return payload?.entry?.[0]?.changes?.[0]?.field ?? 'unknown';
}
