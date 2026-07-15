import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { parseAccentColor } from './branding.util';

// Límites del logo. 2 MB basta para un logo; corta antes de bufferizar de más.
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

export interface UploadedLogo {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
}

// Branding white-label del tenant: nombre, color de acento y logo. Guardado en
// el propio Tenant (sin modelo aparte). El logo se sirve vía URL firmada de storage.
@Injectable()
export class BrandingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // Branding del propio tenant (autenticado). Incluye logoUrl firmada si hay logo.
  async get(tenantId: string) {
    return this.view(tenantId);
  }

  // Versión pública (para el widget embebido): solo name/accentColor/logoUrl.
  // Es lo mismo que view() — el branding es público por diseño. Se separa para
  // dejar explícito que este endpoint NO expone nada sensible.
  async getPublic(tenantId: string) {
    return this.view(tenantId);
  }

  async update(tenantId: string, body: any) {
    const data: { name?: string; accentColor?: string | null } = {};

    if (body?.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        throw new BadRequestException('El nombre no puede estar vacío');
      }
      data.name = body.name.trim();
    }
    if (body?.accentColor !== undefined) {
      try {
        data.accentColor = parseAccentColor(body.accentColor);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
    }

    if (Object.keys(data).length) {
      await this.prisma.tenant.update({ where: { id: tenantId }, data });
    }
    return this.view(tenantId);
  }

  async uploadLogo(tenantId: string, file: UploadedLogo) {
    if (!file) throw new BadRequestException('Falta el archivo (campo "file")');
    if (!LOGO_MIMES.includes(file.mimetype)) {
      throw new BadRequestException('El logo debe ser PNG, JPEG, WEBP o SVG');
    }
    if (file.size > MAX_LOGO_BYTES) {
      throw new BadRequestException('El logo supera 2 MB');
    }
    const logoKey = await this.storage.put(file.buffer, file.mimetype, file.originalname);
    await this.prisma.tenant.update({ where: { id: tenantId }, data: { logoKey } });
    return this.view(tenantId);
  }

  private async view(tenantId: string) {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, accentColor: true, logoKey: true },
    });
    if (!t) throw new NotFoundException('Tenant no encontrado');
    return {
      name: t.name,
      accentColor: t.accentColor,
      // URL firmada fresca en cada lectura (TTL 1h, sobra para una carga de página).
      logoUrl: t.logoKey ? this.storage.signedUrl(t.logoKey) : null,
    };
  }
}
