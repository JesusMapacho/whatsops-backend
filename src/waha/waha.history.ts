// Conversión de un mensaje del historial de WAHA a nuestra forma.
// Puro, sin DB → testeable en aislamiento (waha.history.check.ts).
import { kindForMime } from '../messaging/media.util';

export interface HistoryRow {
  wamid: string;
  direction: 'in' | 'out';
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

// `null` si el mensaje no es utilizable (sin id, o de un chat que no atendemos).
export function toHistoryRow(raw: any): HistoryRow | null {
  if (!raw?.id || typeof raw.id !== 'string') return null;

  const mime: string | undefined = raw.media?.mimetype;
  const type = raw.hasMedia && mime ? kindForMime(mime) : 'text';
  const participant = raw.participant ?? raw._data?.key?.participant;

  return {
    wamid: raw.id,
    direction: raw.fromMe ? 'out' : 'in',
    type,
    payload: {
      // Misma forma normalizada que usa el resto: la bandeja lee `text.body`.
      text: { body: raw.body ?? '' },
      // Marca de importado: el hilo avisa de que un adjunto viejo no está.
      imported: true,
      ...(raw.hasMedia ? { mediaMissing: true, mimeType: mime ?? null } : {}),
      ...(participant ? { author: { waId: participant } } : {}),
      ...(raw.replyTo?.id ? { replyToWamid: raw.replyTo.id } : {}),
    },
    // WAHA manda el timestamp en SEGUNDOS. Sin multiplicar, `new Date(1741249702)`
    // es el 20 de enero de 1970 y el historial aparecería medio siglo antes que el
    // resto de la conversación.
    createdAt: new Date(Number(raw.timestamp ?? 0) * 1000),
  };
}

// Descarta lo que no se puede o no se debe importar: sin id, sin fecha creíble, o
// más nuevo que lo que ya tenemos (eso ya llegó por webhook).
export function usableHistory(rows: (HistoryRow | null)[], oldestKnown: Date | null): HistoryRow[] {
  return rows.filter((r): r is HistoryRow => {
    if (!r) return false;
    if (!Number.isFinite(r.createdAt.getTime()) || r.createdAt.getTime() <= 0) return false;
    // Solo lo ANTERIOR a lo que ya hay: el resto es ruido o duplicado.
    return !oldestKnown || r.createdAt < oldestKnown;
  });
}
