// Funciones puras de mensajería: ventana de 24 h, cuerpo Graph y mapeo de errores.
// Sin dependencias de Nest para poder testearlas en messaging.check.ts.

const WINDOW_MS = 24 * 60 * 60 * 1000;

// `replyTo` = wamid del mensaje citado. Opcional y transversal a los dos tipos.
//
// `params` son los VALORES que teclea el operador, en el orden de `templateParams`.
// `components` (la forma de Meta) la construye el SERVIDOR a partir de ellos y no se
// acepta del cliente: aceptarla dejaba que el navegador definiera el cuerpo del envío
// —y que un cliente viejo mandara una forma inválida a 500 destinatarios de golpe.
export type SendDto =
  | { type: 'text'; text: string; replyTo?: string }
  | {
      type: 'template';
      name: string;
      language: string;
      params?: string[];
      components?: unknown[];
      replyTo?: string;
    };

// Dentro de la ventana de servicio si el último entrante fue hace < 24 h.
export function isWithinWindow(
  lastInboundAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < WINDOW_MS;
}

// Construye el cuerpo que espera POST /{phoneNumberId}/messages.
export function buildMessagePayload(to: string, dto: SendDto): object {
  const base = {
    messaging_product: 'whatsapp',
    to,
    // Cita: en Cloud API se llama `context.message_id`.
    ...(dto.replyTo ? { context: { message_id: dto.replyTo } } : {}),
  };
  if (dto.type === 'template') {
    return {
      ...base,
      type: 'template',
      template: {
        name: dto.name,
        language: { code: dto.language },
        ...(dto.components ? { components: dto.components } : {}),
      },
    };
  }
  return { ...base, type: 'text', text: { body: dto.text } };
}

// Forma NORMALIZADA que se PERSISTE de un saliente, igual en todos los canales.
// Distinta de buildMessagePayload, que es el cuerpo que espera Meta.
//
// Por qué existen las dos: guardar el cuerpo del proveedor dejaba `payload.text`
// como string en WAHA (`{session, chatId, text:'hola'}`) y como `message.text` en
// Messenger, mientras la bandeja, la vista previa y la búsqueda leen
// `payload.text.body` → burbuja vacía y búsqueda ciega. Se usa la forma de Meta
// porque es la que ya esperaba el frontend y a la que normalizan los decoders.
export function storedTextPayload(dto: SendDto): object {
  // El wamid citado se guarda para que el hilo pueda pintar la cita.
  const quote = dto.replyTo ? { replyToWamid: dto.replyTo } : {};
  if (dto.type === 'template') {
    return {
      ...quote,
      template: {
        name: dto.name,
        language: { code: dto.language },
        ...(dto.components ? { components: dto.components } : {}),
      },
    };
  }
  return { ...quote, text: { body: dto.text } };
}

// Mapea códigos de error comunes de la Graph API a mensajes accionables.
// https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
export function mapGraphError(json: any): string {
  const err = json?.error ?? {};
  const code = Number(err.code);
  switch (code) {
    case 190:
      return 'Token de acceso inválido o expirado. Reconecta la WABA.';
    case 131030:
      return 'El número no está en la lista de destinatarios permitidos (app en modo de prueba).';
    case 131026:
      return 'El destinatario no tiene WhatsApp o no puede recibir el mensaje.';
    case 131047:
      return 'Ventana de 24 h cerrada: este mensaje requiere una plantilla.';
    // Los tres que solo salen al escribir en frío. 131048 es el que NO se puede
    // ignorar: Meta está diciendo que nos está marcando como spam, y seguir
    // enviando después de eso es autolesión — aborta el envío masivo.
    case 131048:
      return 'Meta bloqueó el envío por límite de spam. Detén el envío y revisa a quién le escribes.';
    case 131049:
      return 'Meta decidió no entregar este mensaje de marketing para cuidar la experiencia del usuario.';
    case 130472:
      return 'Este usuario está en un experimento de Meta y no recibe mensajes de marketing.';
    case 100:
      return err.message ?? 'Parámetro inválido en la solicitud.';
    default:
      // 132xxx: errores de plantilla (no existe, no aprobada, params no coinciden).
      if (code >= 132000 && code < 133000) {
        return 'Plantilla no válida o no aprobada por Meta.';
      }
      return err.message ?? 'Meta rechazó el envío.';
  }
}

// Extrae el texto del componente BODY de una plantilla de Meta.
export function templateBody(components: any): string | null {
  if (!Array.isArray(components)) return null;
  const body = components.find((c) => c?.type === 'BODY');
  return typeof body?.text === 'string' ? body.text : null;
}
