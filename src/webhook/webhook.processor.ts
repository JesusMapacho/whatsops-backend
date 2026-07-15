import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import type { WabaConnection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { CryptoService } from '../crypto/crypto.service';
import { StorageService } from '../storage/storage.service';
import { downloadFromGraph, withMediaUrl, MediaKind } from '../messaging/media.util';
import { decodeWebhook, InboundMessage, StatusUpdate } from './decode';
import { WEBHOOK_QUEUE } from './webhook.service';

const MEDIA_TYPES = new Set<string>(['image', 'document', 'audio', 'video', 'sticker']);
const GRAPH_VERSION = 'v22.0';

// Worker de la cola webhook-events. Reintentos/backoff los configura el módulo.
@Processor(WEBHOOK_QUEUE)
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);
  private readonly graphVersion: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly crypto: CryptoService,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    super();
    this.graphVersion = config.get<string>('GRAPH_API_VERSION') ?? GRAPH_VERSION;
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
        if (!change.channelRef) continue;
        // Resolución de tenant por (platform, id externo). Único en BD.
        const conn = await this.prisma.wabaConnection.findUnique({
          where: { platform_phoneNumberId: { platform: change.platform, phoneNumberId: change.channelRef } },
        });
        if (!conn) {
          throw new Error(`Sin conexión ${change.platform} para ${change.channelRef}`);
        }
        tenantId = conn.tenantId;
        for (const msg of change.messages) {
          await this.handleInbound(conn, msg);
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

  private async handleInbound(conn: WabaConnection, msg: InboundMessage) {
    const tenantId = conn.tenantId;
    // Idempotencia: wamid ya visto → no duplicar (replay de la feature 06 es seguro).
    const seen = await this.prisma.message.findUnique({ where: { wamid: msg.wamid } });
    if (seen) return;

    const contact = await this.prisma.contact.upsert({
      where: { tenantId_platform_waId: { tenantId, platform: conn.platform, waId: msg.from } },
      create: { tenantId, platform: conn.platform, waId: msg.from, name: msg.contactName },
      update: msg.contactName ? { name: msg.contactName } : {},
    });

    const open = await this.prisma.conversation.findFirst({
      where: { tenantId, contactId: contact.id, wabaConnectionId: conn.id, status: { not: 'closed' } },
      orderBy: { createdAt: 'desc' },
    });
    const conversation = open
      ? await this.prisma.conversation.update({
          where: { id: open.id },
          data: { lastInboundAt: new Date() },
        })
      : await this.prisma.conversation.create({
          data: {
            tenantId,
            platform: conn.platform,
            contactId: contact.id,
            wabaConnectionId: conn.id,
            status: 'open',
            lastInboundAt: new Date(),
          },
        });

    // Media entrante: descargar de Meta y guardar en storage; el payload se normaliza.
    const payload = MEDIA_TYPES.has(msg.type)
      ? await this.ingestMedia(conn, msg)
      : (msg.payload as object);

    const created = await this.prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        direction: 'in',
        type: msg.type,
        payload,
        wamid: msg.wamid,
        status: 'delivered',
      },
    });
    this.events.emitToTenant(
      tenantId,
      'message:new',
      withMediaUrl(created, (k) => this.storage.signedUrl(k)),
    );
  }

  // Descarga el binario de Meta y lo guarda; devuelve el payload normalizado
  // { kind, mediaKey, mimeType, filename?, caption? }. Si falla, no rompe el evento:
  // persiste el mensaje marcado con error para que el hilo lo muestre.
  private async ingestMedia(conn: WabaConnection, msg: InboundMessage): Promise<object> {
    const kind = msg.type as MediaKind;
    // WhatsApp entrega un media-id que hay que resolver contra Graph con el token;
    // Messenger/IG entregan la URL directa del adjunto (no requiere token).
    if (conn.platform === 'whatsapp') {
      const raw = (msg.payload as any)?.[kind] ?? {};
      const mediaId: string | undefined = raw.id;
      const caption: string | undefined = raw.caption;
      const filename: string | undefined = raw.filename;
      if (!mediaId) return { kind, error: true };
      try {
        const token = this.crypto.decrypt(conn.accessTokenEnc);
        const { buffer, mime } = await downloadFromGraph(token, this.graphVersion, mediaId);
        const mediaKey = await this.storage.put(buffer, mime, filename);
        return {
          kind,
          mediaKey,
          mimeType: mime,
          ...(filename ? { filename } : {}),
          ...(caption ? { caption } : {}),
        };
      } catch (err) {
        this.logger.warn(`No se pudo descargar media ${mediaId}: ${(err as Error).message}`);
        return { kind, mimeType: raw.mime_type ?? null, ...(caption ? { caption } : {}), error: true };
      }
    }

    // Messenger / Instagram: attachments[0].payload.url (URL temporal firmada por Meta).
    const url: string | undefined = (msg.payload as any)?.attachments?.[0]?.payload?.url;
    if (!url) return { kind, error: true };
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const mime = res.headers.get('content-type') ?? 'application/octet-stream';
      const mediaKey = await this.storage.put(buffer, mime);
      return { kind, mediaKey, mimeType: mime };
    } catch (err) {
      this.logger.warn(`No se pudo descargar adjunto ${conn.platform}: ${(err as Error).message}`);
      return { kind, error: true };
    }
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
