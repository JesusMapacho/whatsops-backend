import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { StorageService } from '../storage/storage.service';
import { channelAdapter } from './channels';
import { UploadedMediaFile } from './messaging.service';
import { isVoiceMime, validateMedia } from './media.util';
import { checkNumberExists, sessionMeId } from '../waha/waha.client';
import { ContactListsService } from '../contacts/contact-lists.service';
import { Actor } from '../contacts/access';
import { isCanonicalWaId } from './contact-resolve';
import { pickSelected } from '../contacts/pick';

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
// Destinatarios concretos por estado. Cada uno cuesta una consulta para resolver su
// chatId canónico; para audiencias grandes está "todos", que no consulta nada.
const MAX_CONTACTS = 200;

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
    private readonly lists: ContactListsService,
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
  async publish(
    tenantId: string,
    userId: string,
    actor: Actor,
    body: any,
    file?: UploadedMediaFile,
  ) {
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
    // Tres audiencias posibles, y una de ellas es la que de verdad funciona bien.
    //
    // Desde una CARTERA los destinatarios son `Contact.waId`: JIDs canónicos que
    // vinieron de conversaciones reales, o sea los mismos que hacen funcionar el camino
    // de "todos". Es el arreglo de fondo del bug de los estados — con números escritos a
    // mano, WhatsApp devolvía 201 y no lo veía nadie.
    const listId = typeof body?.contactListId === 'string' ? body.contactListId : '';
    const all = body?.all === true || body?.all === 'true';
    const contacts = listId
      ? pickSelected(await this.lists.usableMembers(tenantId, actor, listId), body?.contactIds).map(
          audienceIdOf,
        )
      : parseContacts(body?.contacts);
    if (!all && !contacts.length) {
      throw new BadRequestException(
        listId
          ? 'Esa cartera no tiene a nadie a quien publicarle.'
          : 'Elige a quién: una cartera, unos contactos, o marca explícitamente "todos mis contactos".',
      );
    }
    // Tope: cada destinatario cuesta una consulta al proveedor para resolver su
    // canónico. Quien quiera publicar a cientos usa "todos", que no consulta nada.
    if (contacts.length > MAX_CONTACTS) {
      throw new BadRequestException(
        `Máximo ${MAX_CONTACTS} contactos por estado. Para más, usa "todos mis contactos".`,
      );
    }

    const kind = this.kindOf(file);
    // Resolver ANTES de subir el media: si un número no existe, mejor fallar sin
    // haber guardado una copia del archivo que nadie va a ver.
    //
    // Desde una cartera NO se resuelve nada: los waId ya son canónicos. `resolveAudience`
    // los deja pasar tal cual porque llevan `@`, así que la consulta por destinatario se
    // ahorra sola — pero lo que importa es que no hay nada que adivinar.
    const audiencia = all ? [] : await this.withOwner(conn, await this.resolveAudience(conn, contacts));
    const payload: Record<string, unknown> = {
      session: conn.phoneNumberId,
      ...(all ? {} : { contacts: audiencia }),
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
    // El id que devuelve WAHA es lo único que permite luego cruzar un estado con lo
    // que se ve (o no se ve) en el teléfono. Sin esto, "no aparece" no se puede
    // depurar sin leer los logs del contenedor.
    this.logger.log(`WAHA aceptó el estado ${kind}: ${JSON.stringify(json).slice(0, 200)}`);

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

  // Convierte lo que escribió el operador en chatIds CANÓNICOS preguntándoselos al
  // proveedor, uno por uno.
  //
  // Es el mismo `check-exists` de la fase 4, y aquí es todavía más necesario: un
  // mensaje mal dirigido devuelve un error de Meta o de WAHA, pero un ESTADO mal
  // dirigido devuelve 201 y simplemente no lo ve nadie. Sin esta resolución, publicar
  // a contactos concretos falla en silencio para cualquier número mexicano o argentino
  // escrito como se marca.
  //
  // Un número que no existe se RECHAZA con su nombre en el mensaje: publicar a medias
  // sin decir a quién no llegó es peor que no publicar.
  private async resolveAudience(
    conn: { baseUrl: string | null; phoneNumberId: string; accessTokenEnc: string },
    entries: string[],
  ): Promise<string[]> {
    const baseUrl = conn.baseUrl ?? this.wahaUrl;
    const apiKey = this.crypto.decrypt(conn.accessTokenEnc);
    const out: string[] = [];
    const noExisten: string[] = [];
    for (const entry of entries) {
      // Un chatId ya formado se respeta: quien lo pasa ya sabe lo que hace.
      if (entry.includes('@')) {
        out.push(entry);
        continue;
      }
      const check = await checkNumberExists(baseUrl, apiKey, conn.phoneNumberId, entry).catch(
        () => null,
      );
      if (check && !check.exists) {
        noExisten.push(entry);
        continue;
      }
      // Sin comprobación posible no se inventa nada: se usa lo escrito y se avisa.
      if (!check?.chatId) {
        this.logger.warn(`No se pudo resolver ${entry}: el estado puede no llegarle.`);
        out.push(`${entry}@c.us`);
        continue;
      }
      out.push(check.chatId);
    }
    if (noExisten.length) {
      throw new BadRequestException(
        `Estos números no tienen WhatsApp: ${noExisten.join(', ')}. Quítalos y vuelve a intentarlo.`,
      );
    }
    return [...new Set(out)];
  }

  // Mete el PROPIO número de la sesión en la lista de destinatarios.
  //
  // Dos razones, y la primera es un bug observado. WAHA trocea los destinatarios en
  // lotes de tamaño `contacts.length`, pero antes de trocear AÑADE el número del
  // dueño a la lista. O sea que con N contactos hay N+1 destinatarios en lotes de N:
  // siempre sobra uno y el estado se envía DOS VECES, con el mismo id de mensaje.
  // Verificado en los logs de la instancia: `to 2 participants, chunks: 2, size: 1`.
  // Mandando el dueño nosotros, `contacts.length` ya cuadra con la lista real y sale
  // en un solo lote.
  //
  // Segunda razón: el dueño tiene que estar en la audiencia para poder COMPROBAR que
  // se publicó. Un estado que el que lo publica no ve es indistinguible de uno que
  // falló.
  private async withOwner(
    conn: { baseUrl: string | null; phoneNumberId: string; accessTokenEnc: string },
    contacts: string[],
  ): Promise<string[]> {
    const me = await sessionMeId(
      conn.baseUrl ?? this.wahaUrl,
      this.crypto.decrypt(conn.accessTokenEnc),
      conn.phoneNumberId,
    ).catch(() => null);
    if (!me) {
      // Sin el propio número seguimos publicando: WAHA lo añade igual, solo que con
      // el lote descuadrado. Mejor un envío duplicado que no publicar.
      this.logger.warn('No se pudo leer el número de la sesión: el estado irá en dos lotes.');
      return contacts;
    }
    return contacts.includes(me) ? contacts : [me, ...contacts];
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

// Identificador con el que un miembro de la cartera puede recibir un ESTADO.
//
// No sirve usar el `waId` a ciegas, y esto se descubrió mirando datos reales: con LID
// addressing el waId es un `<n>@lid`, y la lista de destinatarios de un estado que SÍ
// funciona (la de toda la libreta) va en formato `@s.whatsapp.net`. Un `@lid` ahí es otro
// formato: se acepta y no se ve — el mismo fallo silencioso de siempre.
//
// Para ENVIAR un mensaje el `@lid` va perfecto (toda la feature 28 funciona así); es solo
// la audiencia de un estado la que necesita el número. Así que cuando el waId no es
// canónico se devuelven los DÍGITOS, y `resolveAudience` los convierte preguntando a WAHA.
export function audienceIdOf(c: { waId: string; phone: string | null }): string {
  if (isCanonicalWaId('waha', c.waId)) return c.waId;
  return c.phone ?? c.waId;
}

// Trocea lo que escribió el operador en entradas sueltas: teléfonos en dígitos, o
// chatIds ya formados (que se respetan tal cual).
//
// OJO con lo que este parser NO hace: NO fabrica el chatId pegando `@c.us` a los
// dígitos. Fabricarlo era un bug real — en México el número que se marca (`52 871…`)
// no es el `wa_id` (`521871…`), así que el estado salía dirigido a un destinatario
// que NO EXISTE: WAHA lo aceptaba, WhatsApp devolvía 201 y nadie lo veía nunca.
// El canónico lo da el proveedor (`resolveAudience`), no la aritmética.
export function parseContacts(raw: unknown): string[] {
  const items = Array.isArray(raw)
    ? raw.map((c) => String(c))
    : String(raw ?? '')
        .split(/[\n,;]/)
        .map((s) => s.trim());
  const out = items
    .filter(Boolean)
    .map((c) => (c.includes('@') ? c : c.replace(/\D/g, '')))
    .filter(Boolean);
  // Sin duplicados: publicar dos veces al mismo contacto no hace nada, pero infla el
  // recuento de audiencia que queda en el registro.
  return [...new Set(out)];
}
