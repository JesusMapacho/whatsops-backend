import { createHmac, timingSafeEqual } from 'node:crypto';

// Meta firma el POST con HMAC-SHA256(rawBody, appSecret) y lo manda en el header
// X-Hub-Signature-256: "sha256=<hex>". Comparación en tiempo constante.
export function verifySignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let received: Buffer;
  try {
    received = Buffer.from(header.slice('sha256='.length), 'hex');
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}
