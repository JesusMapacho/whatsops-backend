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
import { decodeWebhook, InboundMessage, MessageMutation, StatusUpdate } from './decode';
import { applyReaction } from './mutations';
import { fetchPayloadBinary, wahaMediaUrl } from '../waha/waha.url';
import { openConversation, resolveContact } from '../messaging/contact-resolve';
import { addToSystemList } from '../contacts/system-list';
import { autoDealOnInbound } from '../crm/auto-deal';
import { WEBHOOK_QUEUE } from './webhook.service';

const MEDIA_TYPES = new Set<string>(['image', 'document', 'audio', 'video', 'sticker']);
const ALLOWED_STATUS = new Set<string>(['sent', 'delivered', 'read', 'failed']);
// Ventana en la que un eco puede adoptar la fila de nuestro propio envío.
const CLAIM_WINDOW_MS = 2 * 60 * 1000;
const GRAPH_VERSION = 'v22.0';

// Worker de la cola webhook-events. Reintentos/backoff los configura el módulo.
@Processor(WEBHOOK_QUEUE)
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);
  private readonly graphVersion: string;
  private readonly wahaUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly crypto: CryptoService,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    super();
    this.graphVersion = config.get<string>('GRAPH_API_VERSION') ?? GRAPH_VERSION;
    this.wahaUrl = (config.get<string>('WAHA_URL') ?? '').replace(/\/$/, '');
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
        for (const mut of change.mutations ?? []) {
          await this.handleMutation(conn.tenantId, mut);
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

    // Misma función que usa la creación de conversación en frío: si se duplicara la
    // lógica aquí, los dos caminos derivarían y volverían los contactos partidos.
    const contact = await resolveContact(this.prisma, {
      tenantId,
      platform: conn.platform,
      waId: msg.from,
      phone: msg.phone,
      name: msg.contactName,
      isGroup: msg.isGroup,
    });

    // `lastInboundAt` es la fuente de verdad de la ventana de 24 h: un eco NUESTRO
    // no debe extenderla (en los canales de Meta eso llevaría a un 131047).
    const conversation = await openConversation(this.prisma, {
      tenantId,
      platform: conn.platform,
      contactId: contact.id,
      wabaConnectionId: conn.id,
      inbound: direction === 'in',
    });

    // Cartera de clientes (feature 30): quien nos escribe entra solo en la cartera de
    // sistema. Solo con ENTRANTES, y eso ES la regla de reciprocidad — el eco de lo que
    // el dueño manda desde su teléfono no convierte a nadie en cliente.
    //
    // Mejor esfuerzo: `addToSystemList` se traga sus propios errores y nunca lanza. No
    // anotar a alguien en una lista no puede costar el mensaje de un cliente, que es lo
    // único que el producto promete no perder.
    if (direction === 'in') {
      await addToSystemList(this.prisma, tenantId, contact.id, msg.isGroup);
      // Alta automática de tratos (v8 feature 38), justo detrás y con la misma forma: solo
      // entrantes, mejor esfuerzo, nunca lanza. Apagada por defecto (`Tenant.autoDealOnInbound`)
      // y sin clasificar intención — no adivina si el mensaje es una oportunidad, crea una
      // tarjeta por cada persona que escribe sin trato abierto. Eso lo decide el negocio al
      // encender el interruptor.
      await autoDealOnInbound(this.prisma, tenantId, contact.id, msg.isGroup);
    }

    // Red de seguridad de la duplicación: si el envío por la app no consiguió el
    // wamid de la respuesta del proveedor, su fila quedó con wamid null y el eco no
    // tiene con qué deduplicarse. En ese caso el eco ADOPTA la fila pendiente en
    // vez de crear una segunda.
    // ponytail: casa por (conversación, tipo, texto, últimos 2 min). Techo: dos
    // mensajes idénticos enviados en ese hueco se colapsan en uno — mucho menos
    // malo que duplicar todos. Deja de hacer falta en cuanto messageId acierta.
    if (direction === 'out') {
      const claimed = await this.claimPendingOutbound(tenantId, conversation.id, msg);
      if (claimed) return;
    }

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
      // WAHA puede fallar al bajar el archivo de la CDN de WhatsApp (una URL
      // cifrada que caduca): manda `url: null` y su propio error. No es un fallo
      // nuestro y no tiene arreglo, así que se distingue para poder decirlo.
      if (!media.url) {
        return {
          kind,
          mimeType: media.mimetype ?? null,
          error: true,
          ...(media.error ? { reason: 'provider' } : {}),
        };
      }
      // El caption de WAHA viene en `body`, no dentro de `media`.
      const caption: string | undefined = raw?.body || undefined;
      const filename: string | undefined = media.filename ?? undefined;
      try {
        // El host de la URL del payload NO se usa: se conserva solo la ruta y se
        // pega a la base con la que nosotros alcanzamos la instancia. WAHA la genera
        // con su vista interna (`localhost:3000`), que no coincide con la nuestra, y
        // además así nunca seguimos a un host que elija un tercero.
        const url = wahaMediaUrl(media.url, this.baseUrlOf(conn));
        if (!url) return { kind, error: true };
        const { buffer, mime: fetched } = await fetchPayloadBinary(
          url,
          this.baseUrlOf(conn),
          this.crypto.decrypt(conn.accessTokenEnc),
        );
        const mime = media.mimetype ?? fetched;
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

  // Busca la fila que dejó nuestro propio envío sin wamid y le pone el del eco.
  // Devuelve true si la adoptó (y por tanto no hay que crear nada).
  private async claimPendingOutbound(
    tenantId: string,
    conversationId: string,
    msg: InboundMessage,
  ): Promise<boolean> {
    const body = (msg.payload as any)?.text?.body ?? '';
    const pending = await this.prisma.message.findFirst({
      where: {
        tenantId,
        conversationId,
        direction: 'out',
        wamid: null,
        type: msg.type,
        createdAt: { gt: new Date(Date.now() - CLAIM_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending) return false;
    // Para texto se exige que coincida el cuerpo; para media basta el tipo (el
    // binario ya lo guardamos nosotros y el eco no lo trae igual).
    if (msg.type === 'text' && ((pending.payload as any)?.text?.body ?? '') !== body) {
      return false;
    }

    const updated = await this.prisma.message.update({
      where: { id: pending.id },
      // NO se marca viaDevice: este mensaje SÍ salió de la bandeja.
      data: { wamid: msg.wamid, status: msg.status ?? pending.status },
    });
    this.logger.warn(
      `Eco adoptado por una fila sin wamid (${msg.wamid}). Revisa messageId del adaptador.`,
    );
    this.events.emitToTenant(
      tenantId,
      'message:updated',
      withMediaUrl(updated, (k) => this.storage.signedUrl(k)),
    );
    return true;
  }

  // Reacción o borrado sobre un mensaje ya persistido.
  //
  // Si no tenemos el mensaje (previo al emparejamiento, filtrado por no ser 1-a-1,
  // o de un historial no importado) es un NO-OP, nunca un error: si lanzara, BullMQ
  // reintentaría 3 veces y el evento quedaría `failed` para siempre ensuciando la
  // auditoría, por algo que no tiene arreglo.
  private async handleMutation(tenantId: string, mut: MessageMutation) {
    const target = await this.prisma.message.findUnique({
      where: { tenantId_wamid: { tenantId, wamid: mut.wamid } },
    });
    if (!target) return;

    let updated;
    if (mut.kind === 'revoked') {
      updated = await this.prisma.message.update({
        where: { id: target.id },
        data: { deletedAt: new Date() },
      });
    } else {
      const payload = (target.payload ?? {}) as Record<string, unknown>;
      updated = await this.prisma.message.update({
        where: { id: target.id },
        data: {
          payload: {
            ...payload,
            reactions: applyReaction(payload.reactions, mut.author, mut.emoji),
          },
        },
      });
    }
    this.events.emitToTenant(
      tenantId,
      'message:updated',
      withMediaUrl(updated, (k) => this.storage.signedUrl(k)),
    );
  }

  // Instancia WAHA de esta conexión: la propia (BYO) o la gestionada de env.
  private baseUrlOf(conn: { baseUrl: string | null }): string {
    return conn.baseUrl ?? this.wahaUrl;
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
