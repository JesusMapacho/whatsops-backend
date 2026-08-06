// WAHA (https://waha.devlike.pro): transporte NO oficial de WhatsApp por
// WhatsApp Web, self-hosted. Todo lo puro y sin DB de su webhook vive aquí para
// poder testearlo en aislamiento (ver waha.check.ts).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { MessageStatus } from '@prisma/client';

// Eventos a los que suscribimos la sesión. Menos es mejor: cada evento extra es
// tráfico y filas de WebhookEvent que nadie lee.
//
// `message.any` es superconjunto de `message`: incluye lo que el DUEÑO manda desde
// su propio teléfono, que es como la bandeja se entera de esas respuestas.
// ponytail: se mantienen los dos durante el despliegue. La doble entrega es
// inofensiva (el dedupe por (tenant,wamid) descarta la segunda), y si `message.any`
// se comportara distinto en este build de NOWEB el modo de fallo sería *pérdida
// total del inbound*. Una vez confirmado en /auditoria que `message.any` llega con
// la forma esperada, quitar 'message' de esta lista y subir WAHA_EVENTS_VERSION.
//
// `message.waiting` NO se suscribe a propósito: es el placeholder de un mensaje aún
// no descifrable. Si se decodificara, su wamid quedaría persistido y el mensaje real
// llegando después sería descartado por nuestro propio dedupe, para siempre.
export const WAHA_EVENTS = [
  'message',
  'message.any',
  'message.ack',
  'message.reaction',
  'message.revoked',
  'message.edited',
  'session.status',
];

// Se sube al cambiar WAHA_EVENTS. La config del webhook se fija al CREAR la sesión,
// así que las ya emparejadas se quedarían con la lista vieja y los eventos nuevos
// nunca llegarían, en silencio. La reconciliación compara este número contra
// `WabaConnection.webhookVersion` y re-suscribe una vez.
export const WAHA_EVENTS_VERSION = 2;

// El nombre de sesión SIEMPRE se deriva del tenant, nunca llega del request: es
// la única frontera de tenant en la capa WAHA (la api key es de instancia, así
// que quien la tenga puede enviar como cualquier sesión que sepa nombrar).
// ponytail: una sola sesión WAHA por tenant, garantizado gratis por el
// @@unique([platform, phoneNumberId]). Techo: varios números por tenant.
// Upgrade: sufijo incremental + selector de conexión en la bandeja.
export function wahaSessionName(tenantId: string): string {
  return `t_${tenantId}`;
}

// Clave HMAC por sesión, derivada de un maestro. Se registra en la config del
// webhook al crear la sesión. Derivarla (en vez de una global) evita que una
// sesión pueda forjar webhooks de otra: `GET /api/sessions/{s}` devuelve el
// config —clave incluida— a cualquiera que tenga la api key de instancia.
export function wahaHmacKey(master: string, session: string): string {
  return createHmac('sha512', master).update(session).digest('hex');
}

// WAHA firma HMAC-SHA512(rawBody, key) en hex y **sin prefijo**, a diferencia de
// Meta, que manda "sha256=<hex>" (ver signature.ts). Tiempo constante.
export function verifyWahaSignature(
  rawBody: Buffer,
  header: string | undefined,
  key: string,
): boolean {
  if (!header) return false;
  const expected = createHmac('sha512', key).update(rawBody).digest();
  // Buffer.from ignora los caracteres no-hex en vez de lanzar, así que un
  // header con basura daría un buffer corto: el chequeo de longitud lo caza.
  const received = Buffer.from(header, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

// Acuses de WAHA (numéricos) → nuestro MessageStatus. PLAYED(4) se colapsa en
// read: la bandeja no distingue "escuchado" de "leído".
export const ACK_STATUS: Record<number, MessageStatus> = {
  [-1]: 'failed', // ERROR
  0: 'sent', // PENDING
  1: 'sent', // SERVER
  2: 'delivered', // DEVICE
  3: 'read', // READ
  4: 'read', // PLAYED
};
