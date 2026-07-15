import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Platform } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';

// ponytail: versión de Graph fija con override por env. Subir cuando Meta deprecie.
const GRAPH_VERSION = 'v22.0';

const PLATFORMS: Platform[] = ['whatsapp', 'instagram', 'messenger'];

function parsePlatform(v: unknown): Platform {
  if (v === undefined || v === null || v === '') return 'whatsapp';
  if (typeof v === 'string' && (PLATFORMS as string[]).includes(v)) return v as Platform;
  throw new BadRequestException('platform debe ser whatsapp, instagram o messenger');
}

@Injectable()
export class WabaService {
  private readonly graphVersion: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    config: ConfigService,
  ) {
    this.graphVersion = config.get<string>('GRAPH_API_VERSION') ?? GRAPH_VERSION;
  }

  async create(tenantId: string, body: any) {
    const platform = parsePlatform(body?.platform);
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

  async list(tenantId: string) {
    const conns = await this.prisma.wabaConnection.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return conns.map((c) => this.toPublic(c));
  }

  async remove(tenantId: string, id: string) {
    // deleteMany con tenantId: no se puede borrar la conexión de otro tenant.
    const { count } = await this.prisma.wabaConnection.deleteMany({
      where: { id, tenantId },
    });
    if (!count) throw new NotFoundException('Conexión no encontrada');
    return { deleted: true };
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
