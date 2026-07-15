import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { EventsGateway } from '../events/events.gateway';
import {
  SendDto,
  isWithinWindow,
  templateBody,
} from './messaging.util';
import {
  uploadToGraph,
  validateMedia,
  withMediaUrl,
} from './media.util';
import { channelAdapter } from './channels';
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly events: EventsGateway,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.graphVersion = config.get<string>('GRAPH_API_VERSION') ?? GRAPH_VERSION;
    this.publicBaseUrl = config.get<string>('PUBLIC_BASE_URL') ?? '';
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
      throw new BadRequestException('Las plantillas solo aplican a WhatsApp.');
    }
    if (dto.type === 'text' && !isWithinWindow(conv.lastInboundAt)) {
      throw new BadRequestException(adapter.windowClosedMessage);
    }

    const token = this.crypto.decrypt(conv.wabaConnection.accessTokenEnc);
    const payload = adapter.buildText(conv.contact.waId, dto);
    const url = adapter.sendUrl(conv.wabaConnection.phoneNumberId, this.graphVersion);

    let res: Response;
    let json: any;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      json = await res.json().catch(() => ({}));
    } catch {
      throw new BadRequestException('No se pudo contactar a la Graph API de Meta');
    }

    if (!res.ok) {
      // Persistimos el saliente como failed para que la bandeja lo muestre.
      await this.prisma.message.create({
        data: {
          tenantId,
          conversationId,
          direction: 'out',
          type: dto.type,
          payload,
          status: 'failed',
        },
      });
      throw new BadRequestException(adapter.mapError(json));
    }

    const message = await this.prisma.message.create({
      data: {
        tenantId,
        conversationId,
        direction: 'out',
        type: dto.type,
        payload,
        wamid: json?.messages?.[0]?.id ?? null,
        status: 'sent',
      },
    });
    this.events.emitToTenant(tenantId, 'message:new', message);
    return message;
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
    if (!isWithinWindow(conv.lastInboundAt)) {
      throw new BadRequestException(adapter.windowClosedMessage);
    }

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
    // Messenger/IG: referenciar por URL pública de nuestro storage.
    let mediaRef: string;
    try {
      mediaRef = adapter.needsMediaUpload
        ? await uploadToGraph(
            token,
            this.graphVersion,
            conv.wabaConnection.phoneNumberId,
            file.buffer,
            file.mimetype,
            file.originalname,
          )
        : `${this.publicBaseUrl}${this.storage.signedUrl(mediaKey)}`;
    } catch (e) {
      await this.persistFailed(tenantId, conversationId, kind, dbPayload);
      throw new BadRequestException((e as Error).message);
    }

    const graphBody = adapter.buildMedia(conv.contact.waId, kind, mediaRef, { caption, filename });
    const url = adapter.sendUrl(conv.wabaConnection.phoneNumberId, this.graphVersion);

    let res: Response;
    let json: any;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(graphBody),
      });
      json = await res.json().catch(() => ({}));
    } catch {
      await this.persistFailed(tenantId, conversationId, kind, dbPayload);
      throw new BadRequestException('No se pudo contactar a la Graph API de Meta');
    }

    if (!res.ok) {
      await this.persistFailed(tenantId, conversationId, kind, dbPayload);
      throw new BadRequestException(adapter.mapError(json));
    }

    const message = await this.prisma.message.create({
      data: {
        tenantId,
        conversationId,
        direction: 'out',
        type: kind,
        payload: dbPayload,
        wamid: json?.messages?.[0]?.id ?? null,
        status: 'sent',
      },
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
