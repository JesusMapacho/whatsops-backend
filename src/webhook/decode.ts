// Función pura: aplana el payload de Meta a una lista de cambios normalizados.
// Sin DB ni efectos → testeable en aislamiento (ver decode.check.ts).

export interface InboundMessage {
  wamid: string;
  from: string; // wa_id del contacto
  type: string;
  payload: unknown; // objeto crudo del mensaje
  contactName: string | null;
}

export interface StatusUpdate {
  wamid: string;
  status: string; // sent | delivered | read | failed
}

export interface NormalizedChange {
  phoneNumberId: string | null;
  messages: InboundMessage[];
  statuses: StatusUpdate[];
}

export function decodeWebhook(payload: any): NormalizedChange[] {
  const out: NormalizedChange[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      const nameByWaId = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c?.wa_id && c?.profile?.name) nameByWaId.set(c.wa_id, c.profile.name);
      }
      out.push({
        phoneNumberId: value.metadata?.phone_number_id ?? null,
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

// El primer field del payload sirve como `type` del WebhookEvent (messages, etc.).
export function webhookType(payload: any): string {
  return payload?.entry?.[0]?.changes?.[0]?.field ?? 'unknown';
}
