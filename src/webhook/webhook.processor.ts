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
const ALLOWED_STATUS = new Set<string>(['sent', 'delivered', 'read', 'failed']);
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
        // WAHA reporta el ciclo de vida de la sesión (SCAN_QR_CODE / WORKING /
        // FAILED …); es lo que la UI de emparejamiento sondea.
        if (change.sessionStatus && change.sessionStatus !== conn.status) {
          await this.prisma.wabaConnection.update({
            where: { id: conn.id },
            data: { status: change.sessionStatus },
          });
        }
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
    // Un mensaje puede llegar como saliente: el eco de lo que el dueño manda desde
    // su propio teléfono (evento message.any de WAHA).
    //
    // ponytail: hoy nada auto-responde, así que no hay bucle posible. El día que
    // exista (chatbot v3, asistente), su disparador TIENE que cortar con
    // `if (direction === 'out') return` o se realimentará con su propio eco.
    const direction = msg.direction ?? 'in';
    // Idempotencia por (tenant, wamid) — no global: el id de un mensaje de grupo lo
    // genera el remitente y es el mismo para todos los destinatarios.
    const seen = await this.prisma.message.findUnique({
      where: { tenantId_wamid: { tenantId, wamid: msg.wamid } },
    });
    if (seen) return;

    const contact = await this.prisma.contact.upsert({
      where: { tenantId_platform_waId: { tenantId, platform: conn.platform, waId: msg.from } },
      create: {
        tenantId,
        platform: conn.platform,
        waId: msg.from,
        name: msg.contactName,
        ...(msg.phone ? { phone: msg.phone } : {}),
        ...(msg.isGroup ? { isGroup: true } : {}),
      },
      update: {
        ...(msg.contactName ? { name: msg.contactName } : {}),
        ...(msg.phone ? { phone: msg.phone } : {}),
      },
    });

    const open = await this.prisma.conversation.findFirst({
      where: { tenantId, contactId: contact.id, wabaConnectionId: conn.id, status: { not: 'closed' } },
      orderBy: { createdAt: 'desc' },
    });
    // `lastInboundAt` es la fuente de verdad de la ventana de 24 h: un eco NUESTRO
    // no debe extenderla (en los canales de Meta eso llevaría a un 131047).
    const touch = direction === 'in' ? { lastInboundAt: new Date() } : {};
    const conversation = open
      ? await this.prisma.conversation.update({ where: { id: open.id }, data: touch })
      : await this.prisma.conversation.create({
          data: {
            tenantId,
            platform: conn.platform,
            contactId: contact.id,
            wabaConnectionId: conn.id,
            status: 'open',
            ...(direction === 'in' ? { lastInboundAt: new Date() } : {}),
          },
        });

    // Media entrante: descargar de Meta y guardar en storage; el payload se normaliza.
    const payload = MEDIA_TYPES.has(msg.type)
      ? await this.ingestMedia(conn, msg)
      : (msg.payload as object);

    let created;
    try {
      created = await this.prisma.message.create({
        data: {
          tenantId,
          conversationId: conversation.id,
          direction,
          type: msg.type,
          payload,
          wamid: msg.wamid,
          // Un entrante ya está entregado; un eco nuestro sale del ack que traiga.
          status: direction === 'in' ? 'delivered' : (msg.status ?? 'sent'),
        },
      });
    } catch (e: any) {
      // Carrera con nuestro propio envío por API (el POST persiste a la vez que
      // llega el eco). El otro lado ya guardó la fila: no hay nada que hacer.
      if (e?.code === 'P2002') return;
      throw e;
    }
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

    // WAHA sirve el binario desde su propia instancia (/api/files/…) y exige la api key.
    if (conn.platform === 'waha') {
      const raw = msg.payload as any;
      const media = raw?.media ?? {};
      if (!media.url) return { kind, error: true };
      // El caption de WAHA viene en `body`, no dentro de `media`.
      const caption: string | undefined = raw?.body || undefined;
      const filename: string | undefined = media.filename ?? undefined;
      try {
        const res = await fetch(media.url, {
          headers: { 'X-Api-Key': this.crypto.decrypt(conn.accessTokenEnc) },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const mime = media.mimetype ?? res.headers.get('content-type') ?? 'application/octet-stream';
        const mediaKey = await this.storage.put(buffer, mime, filename);
        return {
          kind,
          mediaKey,
          mimeType: mime,
          ...(filename ? { filename } : {}),
          ...(caption ? { caption } : {}),
        };
      } catch (err) {
        this.logger.warn(`No se pudo descargar media de WAHA: ${(err as Error).message}`);
        return {
          kind,
          mimeType: media.mimetype ?? null,
          ...(caption ? { caption } : {}),
          error: true,
        };
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
    // El decoder ya valida, pero rawPayload puede venir de un replay (feature 06)
    // guardado antes de esa validación: un valor ajeno reventaría el enum.
    if (!ALLOWED_STATUS.has(st.status)) return;
    const { count } = await this.prisma.message.updateMany({
      where: { tenantId, wamid: st.wamid },
      data: { status: st.status },
    });
    if (count) {
      this.events.emitToTenant(tenantId, 'message:status', {
        wamid: st.wamid,
        status: st.status,
      });
    }
  }
}
