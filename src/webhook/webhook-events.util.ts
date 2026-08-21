import { Prisma, WebhookProcessStatus } from '@prisma/client';
import { PLATFORM_TENANT_ID } from '../platform/platform.constants';

export interface WebhookEventFilter {
  type?: string;
  processStatus?: string;
  signatureValid?: boolean;
  from?: Date;
  to?: Date;
}

const STATUSES: WebhookProcessStatus[] = ['pending', 'ok', 'failed'];

// Where de la lista de eventos. Estrictamente el tenant propio.
//
// Los `tenantId: null` NO son visibles para un tenant, y esto no es un detalle: el
// `WebhookEvent` se crea SIN tenant (`webhook.service.ts`, se resuelve después en el
// worker), así que TODO evento de TODO negocio pasa por ese estado. Incluirlos en el
// `OR` —como se hacía— dejaba que el admin de cualquier tenant listara los `pending`
// ajenos y leyera su `rawPayload`, que va sin redactar: texto del mensaje, teléfono y
// nombre del cliente final de otro negocio.
//
// La intención original era ver los "no atribuibles" (los que fallan antes de resolver
// conexión y se quedan en null para siempre). Eso se conserva, pero solo para el
// super-admin: es cross-tenant, y el sitio de lo cross-tenant es el tenant de plataforma.
// Se decide por TENANT y no por `isPlatform` a propósito: esta función es pura y recibe un
// tenantId, mientras que `isPlatform` los guards lo releen de la DB por request (para
// reflejar bajas al instante), así que traerlo aquí costaría una query en cada listado.
//
// Techo conocido: `platform.service.ts` siembra al super-admin en el tenant de plataforma,
// pero si el email YA existía solo levanta la bandera y lo deja en su tenant original. Ese
// super-admin promovido en sitio verá los eventos de su tenant y no los no atribuibles. No
// abre nada —el alcance sigue siendo estricto—, solo le falta una vista. Si alguna vez
// importa, va a `GET /platform/...`, que es donde vive lo cross-tenant.
export function webhookEventScope(tenantId: string): { tenantId: string | null } {
  return { tenantId: tenantId === PLATFORM_TENANT_ID ? null : tenantId };
}

export function buildWebhookEventWhere(
  tenantId: string,
  f: WebhookEventFilter,
): Prisma.WebhookEventWhereInput {
  const where: Prisma.WebhookEventWhereInput = webhookEventScope(tenantId);
  if (f.type) where.type = f.type;
  if (f.processStatus && (STATUSES as string[]).includes(f.processStatus)) {
    where.processStatus = f.processStatus as WebhookProcessStatus;
  }
  if (typeof f.signatureValid === 'boolean') where.signatureValid = f.signatureValid;

  const createdAt: Prisma.DateTimeFilter = {};
  if (f.from) createdAt.gte = f.from;
  if (f.to) createdAt.lte = f.to;
  if (createdAt.gte || createdAt.lte) where.createdAt = createdAt;

  return where;
}
