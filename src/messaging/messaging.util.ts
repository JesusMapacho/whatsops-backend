// Funciones puras de mensajería: ventana de 24 h, cuerpo Graph y mapeo de errores.
// Sin dependencias de Nest para poder testearlas en messaging.check.ts.

const WINDOW_MS = 24 * 60 * 60 * 1000;

export type SendDto =
  | { type: 'text'; text: string }
  | { type: 'template'; name: string; language: string; components?: unknown[] };

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
  const base = { messaging_product: 'whatsapp', to };
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
