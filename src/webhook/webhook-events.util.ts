import { Prisma, WebhookProcessStatus } from '@prisma/client';

export interface WebhookEventFilter {
  type?: string;
  processStatus?: string;
  signatureValid?: boolean;
  from?: Date;
  to?: Date;
}

const STATUSES: WebhookProcessStatus[] = ['pending', 'ok', 'failed'];

// Where de la lista de eventos. Admin: ve los de su tenant + los no atribuibles
// (tenantId null = phone_number_id que no pertenece a ninguna conexión).
export function buildWebhookEventWhere(
  tenantId: string,
  f: WebhookEventFilter,
): Prisma.WebhookEventWhereInput {
  const where: Prisma.WebhookEventWhereInput = {
    OR: [{ tenantId }, { tenantId: null }],
  };
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
