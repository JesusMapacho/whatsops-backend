import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { EventsGateway } from '../events/events.gateway';
import {
  SendDto,
  isWithinWindow,
  storedTextPayload,
  templateBody,
} from './messaging.util';
import {
  uploadToGraph,
  validateMedia,
  withMediaUrl,
} from './media.util';
import { channelAdapter, ChannelAdapter } from './channels';
import { checkLimits, DAY_MS, HOUR_MS, LimitConfig, limitsFromEnv } from './limits';
import { StorageService } from '../storage/storage.service';

// Archivo subido (forma mínima de multer; evita depender de @types/multer).
export interface UploadedMediaFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

// ponytail: versión de Graph fija con override por env (igual que waba.service).
const GRAPH_VERSION = 'v22.0';

@Injectable()
export class MessagingService {
  private readonly graphVersion: string;
  // Base pública para que Meta (Messenger/IG) pueda descargar nuestro media por URL.
  // ponytail: en dev suele quedar vacío (Meta no alcanza localhost); el round-trip
  // real de media en esos canales se verifica en un entorno con URL pública.
  private readonly publicBaseUrl: string;
  // Instancia WAHA gestionada. Una conexión con `baseUrl` propio (BYO) la pisa.
  private readonly wahaUrl: string;
  private readonly limits: LimitConfig;
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly events: EventsGateway,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.graphVersion = config.get<string>('GRAPH_API_VERSION') ?? GRAPH_VERSION;
    this.publicBaseUrl = config.get<string>('PUBLIC_BASE_URL') ?? '';
    this.wahaUrl = config.get<string>('WAHA_URL') ?? '';
    this.limits = limitsFromEnv((k) => config.get<string>(k));
  }

  async send(tenantId: string, conversationId: string, body: any) {
    const dto = parseSendDto(body);

    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      include: { contact: true, wabaConnection: true },
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada');

    const adapter = channelAdapter(conv.platform);
    if (dto.type === 'template' && !adapter.supportsTemplate) {
      throw new BadRequestException('Este canal no soporta plantillas de Meta.');
    }
    // La ventana de 24 h es regla de Meta: WAHA (WhatsApp Web) no la tiene.
    if (dto.type === 'text' && adapter.enforcesWindow && !isWithinWindow(conv.lastInboundAt)) {
      throw new BadRequestException(adapter.windowClosedMessage);
    }
    await this.assertWithinLimits(adapter, tenantId, conversationId);

    const token = this.crypto.decrypt(conv.wabaConnection.accessTokenEnc);
    const session = conv.wabaConnection.phoneNumberId;
    // `wire` = cuerpo que espera el proveedor (difiere por canal).
    // `stored` = lo que guardamos, SIEMPRE en la forma normalizada. Guardar el
    // cuerpo del proveedor dejaba `payload.text` como string en WAHA/Messenger, y
    // la bandeja lee `payload.text.body` → burbuja vacía, vista previa vacía y
    // búsqueda ciega. Además metía `session` en una columna que va al navegador.
    const wire = adapter.buildText(conv.contact.waId, dto, session);
    const stored = storedTextPayload(dto);
    const url = adapter.sendUrl(session, this.graphVersion, this.baseUrlFor(conv.wabaConnection));

    let res: Response;
    let json: any;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: adapter.authHeaders(token),
        body: JSON.stringify(wire),
      });
      json = await res.json().catch(() => ({}));
    } catch {
      throw new BadRequestException('No se pudo contactar al proveedor de mensajería.');
    }

    if (!res.ok) {
      // Persistimos el saliente como failed para que la bandeja lo muestre.
      await this.persistFailed(tenantId, conversationId, dto.type, stored);
      throw new BadRequestException(adapter.mapError(json));
    }

    const message = await this.persistOutbound({
      tenantId,
      conversationId,
      direction: 'out',
      type: dto.type,
      payload: stored,
      wamid: this.messageIdOf(adapter, json),
      status: 'sent',
    });
    this.events.emitToTenant(tenantId, 'message:new', message);
    return message;
  }

  // Guarda un saliente tolerando que el eco del proveedor (message.any) haya
  // creado ya la fila: WAHA emite el evento en milisegundos y el worker puede
  // ganarnos la carrera. Sin esto el `create` reventaría con P2002 y el agente
  // vería un 500 por un mensaje que SÍ se entregó (y al reintentar se duplica).
  private persistOutbound(data: {
    tenantId: string;
    conversationId: string;
    direction: 'out';
    type: string;
    payload: object;
    wamid: string | null;
    status: 'sent' | 'failed';
  }) {
    if (!data.wamid) return this.prisma.message.create({ data });
    const { tenantId, wamid } = data;
    return this.prisma.message.upsert({
      where: { tenantId_wamid: { tenantId, wamid } },
      create: data,
      // Nuestra versión manda: el eco guarda el payload crudo del proveedor.
      update: { payload: data.payload, status: data.status, type: data.type },
    });
  }

  // Base del proveedor: la propia de la conexión (BYO WAHA) o la instancia
  // gestionada de env. Vacío para Meta, que lleva el host en el adaptador.
  private baseUrlFor(conn: { baseUrl: string | null }): string {
    return conn.baseUrl ?? this.wahaUrl;
  }

  // Ritmo y cupo de la capa gratuita. Solo salientes y solo transportes `paced`
  // (WAHA): en los canales de Meta ya limita Meta.
  //
  // NUNCA se aplica a la recepción — cortar entrada perdería el mensaje de un
  // cliente final, que es justo lo que el producto promete no hacer.
  private async assertWithinLimits(
    adapter: ChannelAdapter,
    tenantId: string,
    conversationId: string,
  ) {
    if (!adapter.paced) return;
    try {
      const now = Date.now();
      const [contactLastHour, tenantLastDay, tenant] = await Promise.all([
        this.prisma.message.count({
          where: {
            tenantId,
            conversationId,
            direction: 'out',
            createdAt: { gt: new Date(now - HOUR_MS) },
          },
        }),
        this.prisma.message.count({
          where: { tenantId, direction: 'out', createdAt: { gt: new Date(now - DAY_MS) } },
        }),
        this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } }),
      ]);
      const verdict = checkLimits(
        { contactLastHour, tenantLastDay },
        this.limits,
        tenant?.plan ?? 'free',
      );
      if (!verdict.allowed) throw new HttpException(verdict.message, HttpStatus.TOO_MANY_REQUESTS);
    } catch (e) {
      // El 429 sí sube; un fallo del contador NO deja sin servicio (fail-open).
      if (e instanceof HttpException) throw e;
      this.logger.warn(`No se pudo evaluar el cupo de la capa gratuita: ${(e as Error).message}`);
    }
  }

  // Id del mensaje según el proveedor: WAHA lo devuelve en la raíz, Meta en
  // `messages[0].id`. Sin esto los acuses de WAHA no encontrarían la fila.
  private messageIdOf(adapter: ChannelAdapter, json: any): string | null {
    if (adapter.messageId) return adapter.messageId(json);
    return json?.messages?.[0]?.id ?? null;
  }

  // Envía un adjunto (imagen/documento/audio/video/sticker). El media de sesión
  // (no plantilla) respeta la ventana de 24 h igual que el texto.
  async sendMedia(
    tenantId: string,
    conversationId: string,
    file: UploadedMediaFile,
    caption?: string,
  ) {
    if (!file?.buffer?.length) throw new BadRequestException('Archivo requerido');
    let kind;
    try {
      kind = validateMedia(file.mimetype, file.size);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      include: { contact: true, wabaConnection: true },
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada');
    const adapter = channelAdapter(conv.platform);
    if (adapter.enforcesWindow && !isWithinWindow(conv.lastInboundAt)) {
      throw new BadRequestException(adapter.windowClosedMessage);
    }
    await this.assertWithinLimits(adapter, tenantId, conversationId);

    const token = this.crypto.decrypt(conv.wabaConnection.accessTokenEnc);
    const filename = kind === 'document' ? file.originalname : undefined;
    // Guardamos una copia propia (para el hilo).
    const mediaKey = await this.storage.put(file.buffer, file.mimetype, filename);
    const dbPayload = {
      kind,
      mediaKey,
      mimeType: file.mimetype,
      ...(filename ? { filename } : {}),
      ...(caption ? { caption } : {}),
    };

    // WhatsApp: subir el binario a Meta y referenciar por media-id.
    // WAHA: inline en base64. Messenger/IG: URL pública de nuestro storage.
    let mediaRef: string;
    try {
      if (adapter.needsMediaUpload) {
        mediaRef = await uploadToGraph(
          token,
          this.graphVersion,
          conv.wabaConnection.phoneNumberId,
          file.buffer,
          file.mimetype,
          file.originalname,
        );
      } else if (adapter.mediaAsBase64) {
        // ponytail: inline evita depender de que el proveedor alcance una URL
        // nuestra (PUBLIC_BASE_URL suele estar vacío en dev, y desde el
        // contenedor de WAHA `localhost` es el propio contenedor).
        // Techo: duplica el binario en memoria. Upgrade: servir por URL firmada
        // con WAHA_MEDIA_BASE_URL apuntando al host.
        mediaRef = file.buffer.toString('base64');
      } else {
        mediaRef = `${this.publicBaseUrl}${this.storage.signedUrl(mediaKey)}`;
      }
    } catch (e) {
      await this.persistFailed(tenantId, conversationId, kind, dbPayload);
      throw new BadRequestException((e as Error).message);
    }

    const session = conv.wabaConnection.phoneNumberId;
    const graphBody = adapter.buildMedia(
      conv.contact.waId,
      kind,
      mediaRef,
      { caption, filename, mimeType: file.mimetype },
      session,
    );
    const url = adapter.sendUrl(
      session,
      this.graphVersion,
      this.baseUrlFor(conv.wabaConnection),
      kind,
    );

    let res: Response;
    let json: any;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: adapter.authHeaders(token),
        body: JSON.stringify(graphBody),
      });
      json = await res.json().catch(() => ({}));
    } catch {
      await this.persistFailed(tenantId, conversationId, kind, dbPayload);
      throw new BadRequestException('No se pudo contactar al proveedor de mensajería.');
    }

    if (!res.ok) {
      await this.persistFailed(tenantId, conversationId, kind, dbPayload);
      throw new BadRequestException(adapter.mapError(json));
    }

    const message = await this.persistOutbound({
      tenantId,
      conversationId,
      direction: 'out',
      type: kind,
      payload: dbPayload,
      wamid: this.messageIdOf(adapter, json),
      status: 'sent',
    });
    const withUrl = withMediaUrl(message, (k) => this.storage.signedUrl(k));
    this.events.emitToTenant(tenantId, 'message:new', withUrl);
    return withUrl;
  }

  private persistFailed(tenantId: string, conversationId: string, type: string, payload: object) {
    return this.prisma.message.create({
      data: { tenantId, conversationId, direction: 'out', type, payload, status: 'failed' },
    });
  }

  async syncTemplates(tenantId: string) {
    const conns = await this.prisma.wabaConnection.findMany({
      where: { tenantId, wabaId: { not: null } },
    });
    let synced = 0;
    for (const conn of conns) {
      const token = this.crypto.decrypt(conn.accessTokenEnc);
      const url = `https://graph.facebook.com/${this.graphVersion}/${encodeURIComponent(
        conn.wabaId!,
      )}/message_templates?limit=100`;
      let res: Response;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      } catch {
        throw new BadRequestException('No se pudo contactar a la Graph API de Meta');
      }
      if (!res.ok) continue; // una WABA sin permiso no rompe la sync de las demás
      const json: any = await res.json().catch(() => ({}));
      for (const t of json?.data ?? []) {
        if (!t?.name || !t?.language) continue;
        const data = {
          category: t.category ?? null,
          status: t.status ?? null,
          body: templateBody(t.components),
        };
        await this.prisma.template.upsert({
          where: {
            tenantId_name_language: { tenantId, name: t.name, language: t.language },
          },
          create: { tenantId, name: t.name, language: t.language, ...data },
          update: data,
        });
        synced++;
      }
    }
    return { synced };
  }

  listTemplates(tenantId: string) {
    return this.prisma.template.findMany({
      where: { tenantId, status: 'APPROVED' },
      orderBy: { name: 'asc' },
    });
  }
}

// Validación en la frontera de confianza: el body llega como `any` del cliente.
function parseSendDto(body: any): SendDto {
  if (body?.type === 'template') {
    return {
      type: 'template',
      name: str(body?.name, 'name'),
      language: str(body?.language, 'language'),
      components: Array.isArray(body?.components) ? body.components : undefined,
    };
  }
  if (body?.type === 'text' || body?.text !== undefined) {
    return { type: 'text', text: str(body?.text, 'text') };
  }
  throw new BadRequestException('type debe ser "text" o "template"');
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new BadRequestException(`Campo requerido: ${field}`);
  }
  return v.trim();
}
