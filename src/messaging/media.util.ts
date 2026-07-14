// Funciones puras de media: tipo por MIME, límites de Meta, cuerpo Graph, firma de URL.
// Sin dependencias de Nest para poder testearlas en media.util.check.ts.
import { createHmac, timingSafeEqual } from 'node:crypto';

export type MediaKind = 'image' | 'document' | 'audio' | 'video' | 'sticker';

// Límites por tipo (aprox. Cloud API). Validamos antes de subir a Meta.
export const MEDIA_LIMITS: Record<MediaKind, { mimes: string[]; maxBytes: number }> = {
  image: { mimes: ['image/jpeg', 'image/png'], maxBytes: 5 * 1024 * 1024 },
  sticker: { mimes: ['image/webp'], maxBytes: 500 * 1024 },
  audio: {
    mimes: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'],
    maxBytes: 16 * 1024 * 1024,
  },
  video: { mimes: ['video/mp4', 'video/3gp'], maxBytes: 16 * 1024 * 1024 },
  document: { mimes: [], maxBytes: 100 * 1024 * 1024 }, // document acepta cualquier MIME
};

// Deriva el tipo de mensaje a partir del MIME. webp → sticker; resto de imagen → image.
export function kindForMime(mime: string): MediaKind {
  if (mime === 'image/webp') return 'sticker';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

// Valida MIME + tamaño contra el límite del tipo. Devuelve el kind o lanza Error con mensaje claro.
export function validateMedia(mime: string, size: number): MediaKind {
  const kind = kindForMime(mime);
  const limit = MEDIA_LIMITS[kind];
  if (limit.mimes.length && !limit.mimes.includes(mime)) {
    throw new Error(`MIME no permitido para ${kind}: ${mime}`);
  }
  if (size > limit.maxBytes) {
    throw new Error(
      `Archivo demasiado grande para ${kind}: ${size} bytes (máx ${limit.maxBytes}).`,
    );
  }
  return kind;
}

// Cuerpo que espera POST /{phoneNumberId}/messages para un mensaje de media.
export function buildMediaPayload(
  to: string,
  kind: MediaKind,
  mediaId: string,
  opts: { caption?: string; filename?: string } = {},
): object {
  const media: Record<string, unknown> = { id: mediaId };
  // sticker y audio no soportan caption en Cloud API.
  if (opts.caption && kind !== 'sticker' && kind !== 'audio') media.caption = opts.caption;
  if (kind === 'document' && opts.filename) media.filename = opts.filename;
  return { messaging_product: 'whatsapp', to, type: kind, [kind]: media };
}

// ── Firma de URLs de media (HMAC). Puro: el secreto se inyecta desde el storage. ──
export function signMedia(key: string, exp: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(`${key}.${exp}`).digest('hex');
}

export function verifyMedia(
  key: string,
  exp: string,
  sig: string,
  secret: Buffer,
  now: number = Date.now(),
): boolean {
  if (!key || !exp || !sig) return false;
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || now > expMs) return false;
  const expected = signMedia(key, exp, secret);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Graph API: subir y descargar binarios. Node 18+ trae fetch/FormData/Blob globales. ──
export async function uploadToGraph(
  token: string,
  version: string,
  phoneNumberId: string,
  buffer: Buffer,
  mime: string,
  filename = 'file',
): Promise<string> {
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', mime);
  // Buffer es un BlobPart válido en runtime; el cast evita el tipado estricto de lib.dom.
  fd.append('file', new Blob([buffer as unknown as BlobPart], { type: mime }), filename);
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}/media`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json?.id) {
    throw new Error(json?.error?.message ?? 'Meta rechazó la subida del archivo.');
  }
  return json.id as string;
}

export async function downloadFromGraph(
  token: string,
  version: string,
  mediaId: string,
): Promise<{ buffer: Buffer; mime: string }> {
  const auth = { Authorization: `Bearer ${token}` };
  const metaRes = await fetch(
    `https://graph.facebook.com/${version}/${encodeURIComponent(mediaId)}`,
    { headers: auth },
  );
  const meta: any = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok || !meta?.url) {
    throw new Error(meta?.error?.message ?? 'No se pudo resolver la URL del media.');
  }
  // La URL de descarga de Meta también requiere el Bearer.
  const binRes = await fetch(meta.url, { headers: auth });
  if (!binRes.ok) throw new Error('No se pudo descargar el binario del media.');
  const buffer = Buffer.from(await binRes.arrayBuffer());
  return { buffer, mime: meta.mime_type ?? 'application/octet-stream' };
}

// Añade `payload.mediaUrl` (firmada) si el mensaje tiene mediaKey. No muta el original.
export function withMediaUrl<T extends { payload: any }>(
  msg: T,
  signer: (key: string) => string,
): T {
  const key = msg?.payload?.mediaKey;
  if (!key) return msg;
  return { ...msg, payload: { ...msg.payload, mediaUrl: signer(key) } };
}
