import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { StorageService } from '../storage/storage.service';
import { channelAdapter } from './channels';
import { UploadedMediaFile } from './messaging.service';
import { isVoiceMime, validateMedia } from './media.util';

// Publicar estados ("historias") en el WhatsApp del negocio.
//
// Solo existe en el transporte por QR: el Cloud API es de mensajería y los estados
// son función de consumidor, no expuesta. Se decide por capacidad del adaptador
// (`supportsStatus`), igual que `supportsColdOutreach`.
//
// Riesgo MUCHO menor que escribir en frío, y conviene decirlo: nadie recibe una
// notificación intrusiva, la gente elige mirar. Es lo contrario de lo que dispara las
// marcas de spam, así que NO le aplican los topes en frío. Sí un cupo propio y
// holgado, más que nada contra bucles.
const DEFAULT_MAX_PER_DAY = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

// Los estados de vídeo y voz tienen requisitos de formato que WhatsApp no negocia
// (mp4/h264 y ogg/opus), y WAHA transcodifica si se le pide — el mismo `convert: true`
// que ya usamos para las notas de voz.
type StatusKind = 'text' | 'image' | 'video' | 'voice';

@Injectable()
export class StatusService {
  private readonly logger = new Logger(StatusService.name);
  private readonly wahaUrl: string;
  private readonly maxPerDay: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.wahaUrl = config.get<string>('WAHA_URL') ?? '';
    this.maxPerDay = Number(config.get<string>('STATUS_MAX_PER_DAY')) || DEFAULT_MAX_PER_DAY;
  }

  // Conexiones desde las que se puede publicar, con lo que la UI necesita saber
  // ANTES de publicar (que no se podrá borrar).
  async connections(tenantId: string) {
    const conns = await this.prisma.wabaConnection.findMany({
      where: { tenantId },
      select: { id: true, platform: true, phoneNumberId: true, status: true },
    });
    return conns
      .filter((c) => channelAdapter(c.platform).supportsStatus)
      .map((c) => ({
        ...c,
        canDelete: !!channelAdapter(c.platform).supportsStatusDelete,
      }));
  }

  async list(tenantId: string) {
    const rows = await this.prisma.statusPost.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { createdBy: { select: { id: true, email: true } } },
    });
    // La copia propia del media se sirve firmada: el estado real expira en 24 h y sin
    // esto el registro no podría mostrar qué se publicó.
    return rows.map((r) => ({
      ...r,
      mediaUrl: r.mediaKey ? this.storage.signedUrl(r.mediaKey) : null,
    }));
  }

  // `file` solo para los tipos con media. `contacts` vacío = TODA la libreta, y eso
  // tiene que ser una decisión explícita (ver `all`), no el valor por defecto.
  async publish(tenantId: string, userId: string, body: any, file?: UploadedMediaFile) {
    const conn = await this.prisma.wabaConnection.findFirst({
      where: { id: typeof body?.wabaConnectionId === 'string' ? body.wabaConnectionId : '', tenantId },
    });
    if (!conn) throw new NotFoundException('Conexión no encontrada');
    const adapter = channelAdapter(conn.platform);
    if (!adapter.supportsStatus) {
      throw new BadRequestException(
        'Este canal no puede publicar estados: la API oficial de Meta no lo permite.',
      );
    }

    const today = await this.prisma.statusPost.count({
      where: { tenantId, createdAt: { gt: new Date(Date.now() - DAY_MS) } },
    });
    if (today >= this.maxPerDay) {
      throw new BadRequestException(`Llegaste al máximo de ${this.maxPerDay} estados al día.`);
    }

    // Audiencia. `contacts` ausente publica a TODA la libreta, que en un número de
    // negocio son todos los que han escrito alguna vez: por eso se exige elegir.
    // Acepta array o texto separado por comas/saltos: el formulario viaja como
    // multipart (por el archivo) y ahí un solo `contacts` llega como string, no array.
    const contacts = parseContacts(body?.contacts);
    const all = body?.all === true || body?.all === 'true';
    if (!all && !contacts.length) {
      throw new BadRequestException(
        'Elige a quién: unos contactos, o marca explícitamente "todos mis contactos".',
      );
    }

    const kind = this.kindOf(file);
    const payload: Record<string, unknown> = {
      session: conn.phoneNumberId,
      ...(all ? {} : { contacts }),
    };

    let mediaKey: string | null = null;
    if (kind === 'text') {
      const text = String(body?.text ?? '').trim();
      if (!text) throw new BadRequestException('Escribe el texto del estado.');
      payload.text = text;
      if (body?.backgroundColor) payload.backgroundColor = String(body.backgroundColor);
      if (body?.font !== undefined) payload.font = Number(body.font) || 0;
    } else {
      if (!file?.buffer?.length) throw new BadRequestException('Archivo requerido');
      try {
        validateMedia(file.mimetype, file.size, adapter.extraMimes);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
      // Copia propia: el estado expira en 24 h y el registro tiene que poder mostrar
      // qué se publicó.
      mediaKey = await this.storage.put(file.buffer, file.mimetype, file.originalname);
      payload.file = {
        mimetype: file.mimetype,
        // Inline en base64, igual que los envíos: WAHA no alcanza nuestro localhost,
        // y la doc de los estados acepta `data` además de `url` (verificado).
        data: file.buffer.toString('base64'),
        filename: file.originalname || `estado.${kind}`,
      };
      if (kind === 'video') payload.convert = true;
      // La voz exige ogg/opus y el navegador graba webm: mismo `convert` que las notas.
      if (kind === 'voice' && !isVoiceMime(file.mimetype)) payload.convert = true;
      if (kind === 'image' && body?.caption) payload.caption = String(body.caption);
      if (kind === 'voice' && body?.backgroundColor) {
        payload.backgroundColor = String(body.backgroundColor);
      }
    }

    const base = (conn.baseUrl ?? this.wahaUrl).replace(/\/$/, '');
    const url = `${base}/api/${encodeURIComponent(conn.phoneNumberId)}/status/${kind}`;
    let res: Response;
    let json: any;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: adapter.authHeaders(this.crypto.decrypt(conn.accessTokenEnc)),
        body: JSON.stringify(payload),
      });
      json = await res.json().catch(() => ({}));
    } catch {
      throw new BadRequestException('No se pudo contactar al proveedor de mensajería.');
    }
    if (!res.ok) throw new BadRequestException(adapter.mapError(json));

    const post = await this.prisma.statusPost.create({
      data: {
        tenantId,
        wabaConnectionId: conn.id,
        createdById: userId,
        type: kind,
        text: kind === 'text' ? String(body.text).trim() : null,
        mediaKey,
        mimeType: file?.mimetype ?? null,
        caption: body?.caption ? String(body.caption) : null,
        backgroundColor: body?.backgroundColor ? String(body.backgroundColor) : null,
        // null = toda la libreta. Es información distinta de "0 contactos".
        audienceCount: all ? null : contacts.length,
      },
    });
    this.logger.log(`Estado ${kind} publicado por ${tenantId} a ${all ? 'toda la libreta' : contacts.length}.`);
    return { ...post, mediaUrl: mediaKey ? this.storage.signedUrl(mediaKey) : null };
  }

  // El tipo se deriva del ARCHIVO, no de lo que declare el cliente: creerle es cómo
  // un vídeo acaba publicándose por la ruta de imagen.
  private kindOf(file?: UploadedMediaFile): StatusKind {
    if (!file?.buffer?.length) return 'text';
    const mime = file.mimetype || '';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'voice';
    throw new BadRequestException('Un estado solo puede ser texto, imagen, vídeo o audio.');
  }
}

// Destinatarios de un estado, como los quiere WAHA: chatIds (`<dígitos>@c.us`).
export function parseContacts(raw: unknown): string[] {
  const items = Array.isArray(raw)
    ? raw.map((c) => String(c))
    : String(raw ?? '')
        .split(/[\n,;]/)
        .map((s) => s.trim());
  const out = items
    .filter(Boolean)
    // Un chatId ya formado se respeta; un teléfono a secas se convierte.
    .map((c) => (c.includes('@') ? c : `${c.replace(/\D/g, '')}@c.us`))
    .filter((c) => c !== '@c.us');
  // Sin duplicados: publicar dos veces al mismo contacto no hace nada, pero infla el
  // recuento de audiencia que queda en el registro.
  return [...new Set(out)];
}
