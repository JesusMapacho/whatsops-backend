import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { decodeWebhook, InboundMessage, StatusUpdate } from './decode';
import { WEBHOOK_QUEUE } from './webhook.service';

// Worker de la cola webhook-events. Reintentos/backoff los configura el módulo.
@Processor(WEBHOOK_QUEUE)
export class WebhookProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
  ) {
    super();
  }

  async process(job: Job<{ webhookEventId: string }>) {
    const event = await this.prisma.webhookEvent.findUnique({
      where: { id: job.data.webhookEventId },
    });
    if (!event) return; // evento borrado; nada que hacer

    // Fuera del try: si falla a mitad, conservamos el tenant ya resuelto para
    // que la auditoría (feature 06) pueda atribuir el evento fallido a su tenant.
    let tenantId: string | null = null;
    try {
      for (const change of decodeWebhook(event.rawPayload)) {
        if (!change.phoneNumberId) continue;
        const conn = await this.prisma.wabaConnection.findFirst({
          where: { phoneNumberId: change.phoneNumberId },
        });
        if (!conn) {
          throw new Error(`Sin WabaConnection para phone_number_id ${change.phoneNumberId}`);
        }
        tenantId = conn.tenantId;
        for (const msg of change.messages) {
          await this.handleInbound(conn.tenantId, conn.id, msg);
        }
        for (const st of change.statuses) {
          await this.handleStatus(conn.tenantId, st);
        }
      }
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { tenantId, processStatus: 'ok', processedAt: new Date(), error: null },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { tenantId, processStatus: 'failed', processedAt: new Date(), error: message },
      });
      throw err; // deja que BullMQ reintente con backoff
    }
  }

  private async handleInbound(tenantId: string, wabaConnectionId: string, msg: InboundMessage) {
    // Idempotencia: wamid ya visto → no duplicar (replay de la feature 06 es seguro).
    const seen = await this.prisma.message.findUnique({ where: { wamid: msg.wamid } });
    if (seen) return;

    const contact = await this.prisma.contact.upsert({
      where: { tenantId_waId: { tenantId, waId: msg.from } },
      create: { tenantId, waId: msg.from, name: msg.contactName },
      update: msg.contactName ? { name: msg.contactName } : {},
    });

    const open = await this.prisma.conversation.findFirst({
      where: { tenantId, contactId: contact.id, wabaConnectionId, status: { not: 'closed' } },
      orderBy: { createdAt: 'desc' },
    });
    const conversation = open
      ? await this.prisma.conversation.update({
          where: { id: open.id },
          data: { lastInboundAt: new Date() },
        })
      : await this.prisma.conversation.create({
          data: { tenantId, contactId: contact.id, wabaConnectionId, status: 'open', lastInboundAt: new Date() },
        });

    const created = await this.prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        direction: 'in',
        type: msg.type,
        payload: msg.payload as object,
        wamid: msg.wamid,
        status: 'delivered',
      },
    });
    this.events.emitToTenant(tenantId, 'message:new', created);
  }

  private async handleStatus(tenantId: string, st: StatusUpdate) {
    const status = st.status as 'sent' | 'delivered' | 'read' | 'failed';
    const { count } = await this.prisma.message.updateMany({
      where: { tenantId, wamid: st.wamid },
      data: { status },
    });
    if (count) this.events.emitToTenant(tenantId, 'message:status', { wamid: st.wamid, status });
  }
}
