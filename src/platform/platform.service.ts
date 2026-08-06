import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { PLATFORM_TENANT_ID } from './platform.constants';

const PLATFORM_TENANT_NAME = 'WhatsOps Platform';

@Injectable()
export class PlatformService implements OnModuleInit {
  private readonly logger = new Logger('Platform');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // Siembra el super-admin (isPlatform) en un tenant de plataforma aparte, desde
  // env. Idempotente; nunca asignable desde la gestión de un tenant (feature 02).
  async onModuleInit() {
    const email = this.config.get<string>('PLATFORM_ADMIN_EMAIL');
    const password = this.config.get<string>('PLATFORM_ADMIN_PASSWORD');
    if (!email || !password) return; // opcional: sin env, no se siembra

    const tenant = await this.prisma.tenant.upsert({
      where: { id: PLATFORM_TENANT_ID },
      create: { id: PLATFORM_TENANT_ID, name: PLATFORM_TENANT_NAME },
      update: {},
    });
    const existing = await this.prisma.user.findFirst({ where: { email: email.toLowerCase() } });
    if (existing) {
      if (!existing.isPlatform) {
        await this.prisma.user.update({ where: { id: existing.id }, data: { isPlatform: true } });
      }
      return;
    }
    await this.prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: email.toLowerCase(),
        passwordHash: await bcrypt.hash(password, 10),
        role: 'admin',
        isPlatform: true,
      },
    });
    this.logger.log(`Super-admin sembrado: ${email}`);
  }

  async listTenants(search?: string) {
    const where: Prisma.TenantWhereInput = { id: { not: PLATFORM_TENANT_ID } };
    if (search) where.name = { contains: search, mode: 'insensitive' };
    const tenants = await this.prisma.tenant.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { users: true, wabaConnections: true, conversations: true } } },
    });
    return tenants.map((t) => ({
      id: t.id,
      name: t.name,
      plan: t.plan,
      status: t.status,
      createdAt: t.createdAt,
      counts: t._count,
    }));
  }

  async getTenant(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        users: {
          where: { isPlatform: false },
          select: { id: true, email: true, role: true, status: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
        _count: { select: { conversations: true, messages: true, wabaConnections: true } },
      },
    });
    if (!tenant || tenant.id === PLATFORM_TENANT_ID) throw new NotFoundException('Tenant no encontrado');
    return {
      id: tenant.id,
      name: tenant.name,
      plan: tenant.plan,
      status: tenant.status,
      createdAt: tenant.createdAt,
      usage: tenant._count,
      users: tenant.users,
    };
  }

  // Vista de operación de la capa gratuita: todas las sesiones WAHA de todos los
  // tenants, con su estado y su volumen del día. Es donde el operador detecta al
  // que está spameando (y por tanto quemando la reputación de la instancia
  // compartida) para suspenderlo.
  async wahaSessions() {
    const conns = await this.prisma.wabaConnection.findMany({
      where: { platform: 'waha', tenantId: { not: PLATFORM_TENANT_ID } },
      // Nunca accessTokenEnc (api key cifrada) ni baseUrl (puede llevar credenciales).
      select: {
        id: true,
        tenantId: true,
        phoneNumberId: true,
        status: true,
        createdAt: true,
        tenant: { select: { name: true, plan: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!conns.length) return [];

    // Salientes de las últimas 24 h por tenant, en una sola consulta.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sent = await this.prisma.message.groupBy({
      by: ['tenantId'],
      where: {
        direction: 'out',
        createdAt: { gt: since },
        tenantId: { in: conns.map((c) => c.tenantId) },
      },
      _count: { _all: true },
    });
    const sentByTenant = new Map(sent.map((s) => [s.tenantId, s._count._all]));

    return conns.map((c) => ({
      id: c.id,
      tenantId: c.tenantId,
      tenantName: c.tenant.name,
      plan: c.tenant.plan,
      tenantStatus: c.tenant.status,
      session: c.phoneNumberId,
      status: c.status,
      createdAt: c.createdAt,
      sentLast24h: sentByTenant.get(c.tenantId) ?? 0,
    }));
  }

  async updateTenant(id: string, body: any) {
    if (id === PLATFORM_TENANT_ID) throw new BadRequestException('Tenant de plataforma no editable');
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new NotFoundException('Tenant no encontrado');
    const data: Prisma.TenantUpdateInput = {};
    if (typeof body?.plan === 'string' && body.plan.trim()) data.plan = body.plan.trim();
    if (body?.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'suspended') {
        throw new BadRequestException('status debe ser active|suspended');
      }
      data.status = body.status;
    }
    const updated = await this.prisma.tenant.update({ where: { id }, data });
    return { id: updated.id, name: updated.name, plan: updated.plan, status: updated.status };
  }
}
