import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Platform } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { wahaHmacKey, wahaSessionName } from '../webhook/waha';
import {
  createSession,
  deleteSession,
  fetchQr,
  ping,
  requestPairingCode,
  restartSession,
} from '../waha/waha.client';
import { assertSafeBaseUrl } from '../waha/waha.url';
import { PLATFORM_TENANT_ID } from '../platform/platform.constants';

// ponytail: versión de Graph fija con override por env. Subir cuando Meta deprecie.
const GRAPH_VERSION = 'v22.0';

const PLATFORMS: Platform[] = ['whatsapp', 'instagram', 'messenger', 'waha'];

function parsePlatform(v: unknown): Platform {
  if (v === undefined || v === null || v === '') return 'whatsapp';
  if (typeof v === 'string' && (PLATFORMS as string[]).includes(v)) return v as Platform;
  throw new BadRequestException('platform debe ser whatsapp, instagram, messenger o waha');
}

@Injectable()
export class WabaService {
  private readonly logger = new Logger(WabaService.name);
  private readonly graphVersion: string;
  private readonly wahaUrl: string;
  private readonly wahaKey: string;
  private readonly wahaSecret: string;
  private readonly wahaCallbackUrl: string;
  private readonly fullSync: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    config: ConfigService,
  ) {
    this.graphVersion = config.get<string>('GRAPH_API_VERSION') ?? GRAPH_VERSION;
    this.wahaUrl = config.get<string>('WAHA_URL') ?? '';
    this.wahaKey = config.get<string>('WAHA_API_KEY') ?? '';
    this.wahaSecret = config.get<string>('WAHA_WEBHOOK_SECRET') ?? '';
    this.wahaCallbackUrl = config.get<string>('WAHA_CALLBACK_URL') ?? '';
    this.fullSync = config.get<string>('WAHA_FULL_SYNC') === 'true';
  }

  // Nombre legible de la conexión. Se recorta a 60: es una etiqueta para un selector, y
  // sin tope alguien pega un párrafo y rompe el desplegable.
  private parseLabel(v: unknown): string | null {
    if (typeof v !== 'string' || !v.trim()) return null;
    return v.trim().slice(0, 60);
  }

  // Renombrar. Es lo único editable de una conexión: lo demás (token, id de canal,
  // instancia) define QUÉ conexión es, y cambiarlo sería crear otra.
  async rename(tenantId: string, id: string, body: any) {
    const label = this.parseLabel(body?.label);
    const { count } = await this.prisma.wabaConnection.updateMany({
      where: { id, tenantId },
      data: { label },
    });
    if (!count) throw new NotFoundException('Conexión no encontrada');
    return { id, label };
  }

  async create(tenantId: string, body: any) {
    const platform = parsePlatform(body?.platform);
    // WAHA sale antes: no lleva token de Meta ni id de canal del cliente, y
    // validateToken mandaría su api key a graph.facebook.com.
    if (platform === 'waha') return this.createWaha(tenantId, body);
    const accessToken = str(body?.accessToken, 'accessToken');
    // Id externo del canal: phone_number_id (WA) / page id (Messenger) / IG id.
    const phoneNumberId = str(body?.phoneNumberId, 'phoneNumberId');
    const wabaId =
      platform === 'whatsapp' && typeof body?.wabaId === 'string' && body.wabaId.trim()
        ? body.wabaId.trim()
        : null;

    await this.validateToken(platform, phoneNumberId, accessToken);

    try {
      const conn = await this.prisma.wabaConnection.create({
        data: {
          tenantId,
          platform,
          label: this.parseLabel(body?.label),
          wabaId,
          phoneNumberId,
          accessTokenEnc: this.crypto.encrypt(accessToken),
          // businessId no llega en el flujo de token manual (lo trae Embedded Signup, fase ≥2).
          businessId: null,
          source: 'manual_token',
          status: 'active',
        },
      });
      return this.toPublic(conn);
    } catch (e: any) {
      // Violación del @@unique([platform, phoneNumberId]).
      if (e?.code === 'P2002') {
        throw new BadRequestException('Ya existe una conexión para ese canal e id.');
      }
      throw e;
    }
  }

  // Conecta un WhatsApp por QR contra una instancia WAHA. El nombre de sesión se
  // DERIVA del tenant: nunca llega del body (ver wahaSessionName — la api key de
  // WAHA es de instancia, así que el nombre de sesión es la frontera de tenant).
  private async createWaha(tenantId: string, body: any) {
    // El super-admin no debe tener canales propios: su tenant está excluido de la
    // consola de operación, así que una sesión creada aquí queda doblemente
    // invisible (pasó en las pruebas de la feature 26).
    this.assertNotPlatform(tenantId);
    // BYO: el tenant trae su propia instancia. Si no, la gestionada de env.
    const byo = typeof body?.baseUrl === 'string' && body.baseUrl.trim();
    const baseUrl = byo
      ? await this.safeBaseUrl(body.baseUrl.trim())
      : this.wahaUrl.replace(/\/$/, '');
    const apiKey = byo ? str(body?.apiKey, 'apiKey') : this.wahaKey;

    if (!baseUrl || !apiKey) {
      throw new BadRequestException(
        'WAHA no está configurado en este servidor. Indica la URL y la api key de tu propia instancia.',
      );
    }
    if (!this.wahaCallbackUrl || !this.wahaSecret) {
      throw new BadRequestException(
        'Falta WAHA_CALLBACK_URL o WAHA_WEBHOOK_SECRET en el servidor.',
      );
    }

    await ping(baseUrl, apiKey).catch((e: Error) => {
      throw new BadRequestException(e.message);
    });

    const session = wahaSessionName(tenantId);
    let conn;
    try {
      conn = await this.prisma.wabaConnection.create({
        data: {
          tenantId,
          platform: 'waha',
          label: this.parseLabel(body?.label),
          wabaId: null,
          businessId: null,
          phoneNumberId: session,
          accessTokenEnc: this.crypto.encrypt(apiKey),
          baseUrl: byo ? baseUrl : null,
          source: 'waha_qr',
          status: 'STARTING',
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new BadRequestException('Ya tienes una conexión de WhatsApp por QR.');
      }
      throw e;
    }

    try {
      await createSession(
        baseUrl,
        apiKey,
        session,
        this.wahaCallbackUrl,
        wahaHmacKey(this.wahaSecret, session),
        // El store del engine se fija SOLO aquí: cambiarlo con la sesión ya
        // emparejada puede costar el historial (doc de WAHA).
        this.fullSync,
      );
    } catch (e) {
      // Sin sesión no hay conexión: no dejar la fila huérfana.
      await this.prisma.wabaConnection.delete({ where: { id: conn.id } });
      throw new BadRequestException((e as Error).message);
    }
    return this.toPublic(conn);
  }

  async list(tenantId: string) {
    const conns = await this.prisma.wabaConnection.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return conns.map((c) => this.toPublic(c));
  }

  async remove(tenantId: string, id: string) {
    const conn = await this.prisma.wabaConnection.findFirst({ where: { id, tenantId } });
    if (!conn) throw new NotFoundException('Conexión no encontrada');
    // Borrar solo la fila dejaría la sesión viva y emparejada, mandando webhooks
    // que ya no resuelven a ninguna conexión: cada evento acabaría en `failed`.
    if (conn.platform === 'waha') {
      await deleteSession(
        this.baseUrlOf(conn),
        this.crypto.decrypt(conn.accessTokenEnc),
        conn.phoneNumberId,
      ).catch((e: Error) => this.logger.warn(`No se pudo borrar la sesión WAHA: ${e.message}`));
    }
    // deleteMany con tenantId: no se puede borrar la conexión de otro tenant.
    const { count } = await this.prisma.wabaConnection.deleteMany({
      where: { id, tenantId },
    });
    if (!count) throw new NotFoundException('Conexión no encontrada');
    return { deleted: true };
  }

  // QR de emparejamiento. El `tenantId` de este where ES la frontera de
  // aislamiento: un QR de WhatsApp es una credencial, y sin él cualquier admin
  // podría emparejar su teléfono a la sesión de otro tenant y leer/enviar como
  // ellos. La api key se queda en el servidor: nunca llega al navegador.
  async qr(tenantId: string, id: string) {
    const conn = await this.wahaConn(tenantId, id);
    try {
      return await fetchQr(
        this.baseUrlOf(conn),
        this.crypto.decrypt(conn.accessTokenEnc),
        conn.phoneNumberId,
      );
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  // Emparejamiento por código: en vez de escanear, WhatsApp muestra un código de 8
  // dígitos que el usuario teclea en su teléfono (Dispositivos vinculados →
  // Vincular con número).
  //
  // El código se DEVUELVE y no se guarda ni se loguea: es una credencial de un solo
  // uso para vincular un dispositivo, igual de sensible que el QR.
  async requestCode(tenantId: string, id: string, rawPhone: unknown) {
    const conn = await this.wahaConn(tenantId, id);
    // Solo dígitos, sin '+' ni espacios: es lo que espera WAHA.
    const phone = typeof rawPhone === 'string' ? rawPhone.replace(/\D/g, '') : '';
    if (phone.length < 8 || phone.length > 15) {
      throw new BadRequestException(
        'Indica el número con lada de país, solo dígitos y sin el signo +.',
      );
    }
    // Fuera de SCAN_QR_CODE no hay nada que emparejar (o ya está emparejada).
    if (conn.status !== 'SCAN_QR_CODE') {
      throw new BadRequestException(
        'La sesión no está esperando emparejamiento. Reinicia la conexión e inténtalo de nuevo.',
      );
    }
    try {
      const code = await requestPairingCode(
        this.baseUrlOf(conn),
        this.crypto.decrypt(conn.accessTokenEnc),
        conn.phoneNumberId,
        phone,
      );
      return { code };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  async restart(tenantId: string, id: string) {
    const conn = await this.wahaConn(tenantId, id);
    try {
      await restartSession(
        this.baseUrlOf(conn),
        this.crypto.decrypt(conn.accessTokenEnc),
        conn.phoneNumberId,
      );
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    return { restarted: true };
  }

  // Se comprueba también aquí y no solo al crear: una fila puede ser anterior a la
  // guarda, y el QR es equivalente a una credencial.
  private async wahaConn(tenantId: string, id: string) {
    this.assertNotPlatform(tenantId);
    const conn = await this.prisma.wabaConnection.findFirst({
      where: { id, tenantId, platform: 'waha' },
    });
    if (!conn) throw new NotFoundException('Conexión no encontrada');
    return conn;
  }

  private assertNotPlatform(tenantId: string) {
    if (tenantId === PLATFORM_TENANT_ID) {
      throw new BadRequestException(
        'El super-admin de plataforma no puede conectar canales. Usa el tenant de un cliente.',
      );
    }
  }

  private baseUrlOf(conn: { baseUrl: string | null }): string {
    return conn.baseUrl ?? this.wahaUrl.replace(/\/$/, '');
  }

  private async safeBaseUrl(raw: string): Promise<string> {
    try {
      return await assertSafeBaseUrl(raw);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  // Llamada barata a la Graph API: si el token sirve, devuelve 200 con los campos.
  // WhatsApp valida el phone_number_id; Messenger/IG validan el page/IG id con `name`.
  private async validateToken(platform: Platform, externalId: string, token: string) {
    const fields = platform === 'whatsapp' ? 'display_phone_number,verified_name' : 'name';
    const url = `https://graph.facebook.com/${this.graphVersion}/${encodeURIComponent(
      externalId,
    )}?fields=${fields}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      throw new BadRequestException('No se pudo contactar a la Graph API de Meta');
    }
    if (!res.ok) {
      // No logueamos el token. El cuerpo de error de Meta no lo contiene.
      throw new BadRequestException('Token o id de canal inválido o expirado (rechazado por Meta)');
    }
  }

  private toPublic(c: {
    id: string;
    tenantId: string;
    platform: Platform;
    label: string | null;
    wabaId: string | null;
    phoneNumberId: string;
    businessId: string | null;
    source: string;
    status: string;
    createdAt: Date;
  }) {
    // Nunca exponer accessTokenEnc.
    return {
      id: c.id,
      tenantId: c.tenantId,
      platform: c.platform,
      label: c.label,
      wabaId: c.wabaId,
      phoneNumberId: c.phoneNumberId,
      businessId: c.businessId,
      source: c.source,
      status: c.status,
      createdAt: c.createdAt,
    };
  }
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new BadRequestException(`Campo requerido: ${field}`);
  }
  return v.trim();
}
