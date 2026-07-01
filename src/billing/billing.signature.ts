import { createHmac, timingSafeEqual } from 'node:crypto';

// Verifica la firma del webhook del proveedor de pago. En modo stub (Stripe
// deshabilitado) usa HMAC-SHA256(rawBody, secret) — mismo criterio que el
// webhook de Meta — para poder probar firma válida/ inválida sin cuenta Stripe.
// Con Stripe habilitado, la verificación real la hace el SDK (billing.service).
export function verifyBillingSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!secret || !header) return false;
  const sig = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let received: Buffer;
  try {
    received = Buffer.from(sig, 'hex');
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}
