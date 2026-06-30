import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';

// ponytail: versión de Graph fija con override por env. Subir cuando Meta deprecie.
const GRAPH_VERSION = 'v22.0';

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
    const accessToken = str(body?.accessToken, 'accessToken');
    const phoneNumberId = str(body?.phoneNumberId, 'phoneNumberId');
    const wabaId =
      typeof body?.wabaId === 'string' && body.wabaId.trim()
        ? body.wabaId.trim()
        : null;

    await this.validateToken(phoneNumberId, accessToken);

    const conn = await this.prisma.wabaConnection.create({
      data: {
        tenantId,
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
  private async validateToken(phoneNumberId: string, token: string) {
    const url = `https://graph.facebook.com/${this.graphVersion}/${encodeURIComponent(
      phoneNumberId,
    )}?fields=display_phone_number,verified_name`;
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
      throw new BadRequestException(
        'Token o phone_number_id inválido o expirado (rechazado por Meta)',
      );
    }
  }

  private toPublic(c: {
    id: string;
    tenantId: string;
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
