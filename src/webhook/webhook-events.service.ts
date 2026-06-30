import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { WEBHOOK_QUEUE } from './webhook.service';
import { buildWebhookEventWhere, WebhookEventFilter } from './webhook-events.util';

@Injectable()
export class WebhookEventsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue,
  ) {}

  list(tenantId: string, filter: WebhookEventFilter, limit = 50, before?: string) {
    return this.prisma.webhookEvent.findMany({
      where: buildWebhookEventWhere(tenantId, filter),
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
      ...(before ? { cursor: { id: before }, skip: 1 } : {}),
      // Lista sin rawPayload (pesa); el detalle lo trae completo.
      select: {
        id: true,
        type: true,
        processStatus: true,
        signatureValid: true,
        error: true,
        createdAt: true,
        processedAt: true,
      },
    });
  }

  async get(tenantId: string, id: string) {
    const event = await this.prisma.webhookEvent.findFirst({
      where: { id, OR: [{ tenantId }, { tenantId: null }] },
    });
    if (!event) throw new NotFoundException('Evento no encontrado');
    return event;
  }

  async replay(tenantId: string, id: string) {
    await this.get(tenantId, id); // valida visibilidad/tenant
    await this.prisma.webhookEvent.update({
      where: { id },
      data: { processStatus: 'pending', error: null },
    });
    // Mismo worker de la feature 03; idempotente por wamid → no duplica mensajes.
    await this.queue.add('process', { webhookEventId: id });
    return { requeued: true };
  }
}
