import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { PLATFORM_TENANT_ID } from './platform.constants';
import { RolesService } from '../roles/roles.service';
import { InvitationsService } from '../invitations/invitations.service';
import { MfaService } from '../auth/mfa.service';

const PLATFORM_TENANT_NAME = 'WhatsOps Platform';

@Injectable()
export class PlatformService implements OnModuleInit {
  private readonly logger = new Logger('Platform');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly roles: RolesService,
    private readonly invitations: InvitationsService,
    private readonly mfa: MfaService,
  ) {}

  // Siembra el super-admin (isPlatform) en un tenant de plataforma aparte, desde
  // env. Idempotente; nunca asignable desde la gestión de un tenant (feature 02).
  async onModuleInit() {
    const email = this.config.get<string>('PLATFORM_ADMIN_EMAIL');
    const password = this.config.get<string>('PLATFORM_ADMIN_PASSWORD');
    if (!email || !password) return; // opcional: sin env, no se siembra

    // `onboardingComplete: true` porque el tenant de plataforma no pasa por el asistente
    // de registro. Sin esto, `sign()` devuelve false y el frontend manda al super-admin a
    // /registro en vez de a la consola.
    const tenant = await this.prisma.tenant.upsert({
      where: { id: PLATFORM_TENANT_ID },
      create: { id: PLATFORM_TENANT_ID, name: PLATFORM_TENANT_NAME, onboardingComplete: true },
      update: {},
    });

    // La búsqueda va acotada AL TENANT DE PLATAFORMA, y esto no es un detalle.
    //
    // Antes era `findFirst({ where: { email } })` sin tenant y, si encontraba algo, le
    // ponía `isPlatform: true` dejándolo en su tenant original. Pero el email es único
    // **por tenant** (`@@unique([tenantId, email])`), no globalmente: si un cliente se
    // registraba con el mismo correo que PLATFORM_ADMIN_EMAIL, el siguiente arranque
    // convertía al usuario de ese cliente en super-admin cross-tenant. Y encima
    // `users.service.ts#list` no filtra `isPlatform`, así que aparecía en la lista de su
    // propio equipo.
    //
    // Ahora un choque de correos **falla y se dice**, en vez de resolverse solo por el
    // camino peor. Y con esto `isPlatform` y «estar en el tenant de plataforma» vuelven a
    // ser lo mismo, que es lo que asume `webhookEventScope` para decidir el alcance
    // cross-tenant de la auditoría de webhooks.
    const lower = email.toLowerCase();
    const ajeno = await this.prisma.user.findFirst({
      where: { email: lower, tenantId: { not: PLATFORM_TENANT_ID } },
      select: { id: true, tenantId: true },
    });
    if (ajeno) {
      this.logger.error(
        `PLATFORM_ADMIN_EMAIL (${lower}) ya lo usa un usuario del tenant ${ajeno.tenantId}. ` +
          'No se siembra nada: usa un correo que no tenga ningún cliente.',
      );
      return;
    }

    const existing = await this.prisma.user.findFirst({
      where: { email: lower, tenantId: PLATFORM_TENANT_ID },
    });
    if (existing) {
      if (!existing.isPlatform) {
        await this.prisma.user.update({ where: { id: existing.id }, data: { isPlatform: true } });
        this.logger.log(`Super-admin restaurado: ${lower}`);
      }
      return;
    }
    // Los roles de sistema del tenant de plataforma: `RolesModule` corre ANTES que este
    // módulo (app.module.ts), así que en el primer arranque el tenant todavía no existía y
    // el super-admin nacía con `roleId: null`, rellenado por accidente en el segundo
    // arranque. Sembrarlos aquí lo arregla en el primero.
    const roleId = await this.roles
      .ensureSystemRoles(tenant.id)
      .then((r) => r.adminRoleId)
      .catch((e: Error) => {
        this.logger.warn(`No se pudieron sembrar los roles de plataforma: ${e.message}`);
        return null;
      });

    await this.prisma.user.create({
      data: {
        tenantId: tenant.id,
        roleId,
        email: lower,
        passwordHash: await bcrypt.hash(password, 10),
        role: 'admin',
        isPlatform: true,
      },
    });
    this.logger.log(`Super-admin sembrado: ${lower}`);
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
        label: true,
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

    // Conversaciones abiertas EN FRÍO en 24 h. Sin esto, esta vista no distingue una
    // mesa de soporte ocupada (200 salientes, todos a gente que escribió primero) de
    // un spammer (200 salientes a 200 desconocidos) — y son lo mismo en `sentLast24h`.
    const cold = await this.prisma.conversation.groupBy({
      by: ['tenantId'],
      where: {
        createdAt: { gt: since },
        lastInboundAt: null,
        messages: { some: { direction: 'out' } },
        tenantId: { in: conns.map((c) => c.tenantId) },
      },
      _count: { _all: true },
    });
    const coldByTenant = new Map(cold.map((s) => [s.tenantId, s._count._all]));

    return conns.map((c) => ({
      id: c.id,
      tenantId: c.tenantId,
      tenantName: c.tenant.name,
      plan: c.tenant.plan,
      tenantStatus: c.tenant.status,
      session: c.phoneNumberId,
      // Nombre que le puso el negocio. Al operador le sirve para hablar con el cliente
      // en sus términos ("tu conexión de Ventas") en vez de leerle un id de sesión.
      label: c.label,
      status: c.status,
      createdAt: c.createdAt,
      sentLast24h: sentByTenant.get(c.tenantId) ?? 0,
      coldLast24h: coldByTenant.get(c.tenantId) ?? 0,
    }));
  }

  // Envíos masivos de todos los tenants. Es lo que el operador necesita a las 2 a.m.
  // cuando un tenant está inundando la instancia: verlo y pararlo.
  broadcasts(status?: string) {
    return this.prisma.broadcast.findMany({
      where: {
        tenantId: { not: PLATFORM_TENANT_ID },
        ...(status ? { status } : {}),
      },
      select: {
        id: true,
        tenantId: true,
        status: true,
        reason: true,
        type: true,
        templateName: true,
        total: true,
        sent: true,
        failed: true,
        skipped: true,
        createdAt: true,
        tenant: { select: { name: true, plan: true } },
        wabaConnection: { select: { platform: true, phoneNumberId: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // Carteras de clientes de todos los tenants, con su tamaño.
  //
  // La señal a mirar: en la capa gratuita una cartera solo se llena con gente que
  // escribió, así que 5000 "clientes" en un tenant free significa una de dos cosas — o
  // tiene un negocio de verdad muy activo, o alguien encontró la forma de meter una lista
  // comprada. Las dos merecen una mirada, y sin esta vista no se distinguen.
  async contactLists() {
    const rows = await this.prisma.contactList.findMany({
      where: { tenantId: { not: PLATFORM_TENANT_ID } },
      select: {
        id: true,
        name: true,
        isSystem: true,
        createdAt: true,
        tenantId: true,
        tenant: { select: { name: true, plan: true } },
        _count: { select: { members: true, roles: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((l) => ({
      id: l.id,
      name: l.name,
      isSystem: l.isSystem,
      createdAt: l.createdAt,
      tenantId: l.tenantId,
      tenantName: l.tenant.name,
      plan: l.tenant.plan,
      members: l._count.members,
      // Cuántos roles tienen acceso. 0 = solo el admin del tenant (default cerrado).
      roles: l._count.roles,
    }));
  }

  // Cancelar el envío de OTRO tenant. El guard ya audita quién lo hizo.
  async cancelBroadcast(id: string, body: any) {
    if (body?.status !== 'canceled') {
      throw new BadRequestException('Solo se puede cancelar: status debe ser "canceled"');
    }
    const b = await this.prisma.broadcast.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Envío no encontrado');
    // Misma guarda que `updateTenant`: el tenant de plataforma no es un cliente.
    if (b.tenantId === PLATFORM_TENANT_ID) {
      throw new BadRequestException('Tenant de plataforma no editable');
    }
    await this.prisma.broadcast.updateMany({
      where: { id, status: 'running' },
      data: { status: 'canceled', reason: 'Cancelado por el operador de la plataforma.' },
    });
    // Los pendientes se cierran aquí también: dejarlos "pending" haría que la consola
    // muestre destinatarios que no van a salir nunca. Los jobs NO se borran de Redis
    // (sería una carrera con el worker): el worker relee el estado y no hace nada.
    const { count } = await this.prisma.broadcastRecipient.updateMany({
      where: { broadcastId: id, status: 'pending' },
      data: { status: 'skipped', reason: 'Envío cancelado por la plataforma.' },
    });
    if (count) {
      await this.prisma.broadcast.update({
        where: { id },
        data: { skipped: { increment: count } },
      });
    }
    return { id, status: 'canceled', canceled: count };
  }

  // --- Usuarios de plataforma (§9) -----------------------------------------------------
  //
  // Hasta ahora la única forma de tener un super-admin era la siembra por env, o un UPDATE
  // a mano. Esto permite dar de alta compañeros de revisión sin tocar el servidor, y por
  // `PlatformGuard` cada operación queda auditada.
  //
  // Reusa el flujo de invitaciones tal cual (token de un solo uso, 7 días, contraseña que
  // pone la propia persona). El `isPlatform` lo deriva `invitations.service` del tenant.

  async listPlatformUsers() {
    return this.prisma.user.findMany({
      where: { isPlatform: true },
      select: {
        id: true,
        email: true,
        status: true,
        createdAt: true,
        // Para poder ver de un golpe quién no ha enrolado todavía el segundo factor.
        totpConfirmedAt: true,
        totpLockedUntil: true,
        // Nunca `totpSecretEnc` ni `recoveryCodeHashes`: son credenciales. Solo el conteo.
        recoveryCodeHashes: true,
      },
      orderBy: { createdAt: 'asc' },
    }).then((us) =>
      us.map(({ recoveryCodeHashes, ...u }) => ({
        ...u,
        segundoFactor: u.totpConfirmedAt ? 'activo' : 'sin enrolar',
        respaldoRestante: recoveryCodeHashes.length,
      })),
    );
  }

  /** Invita a un compañero al tenant de plataforma. Devuelve el enlace una sola vez. */
  async invitePlatformUser(invitedById: string, body: any) {
    const { adminRoleId } = await this.roles.ensureSystemRoles(PLATFORM_TENANT_ID);
    return this.invitations.create(PLATFORM_TENANT_ID, invitedById, {
      ...body,
      // El rol dentro del tenant de plataforma es siempre admin: `isPlatform` no es un
      // permiso ni un rol, y el RBAC del tenant de plataforma no gobierna nada.
      roleId: adminRoleId,
    });
  }

  /**
   * Desactiva o reactiva a un compañero. No se borra: `status: 'disabled'` corta el login
   * y conserva la atribución de lo que hizo, igual que en `users.service.ts`.
   */
  async updatePlatformUser(actorUserId: string, id: string, body: any) {
    const user = await this.mustPlatformUser(id);
    if (user.id === actorUserId) {
      throw new BadRequestException('No puedes desactivarte a ti mismo.');
    }
    const status = body?.status;
    if (status !== 'active' && status !== 'disabled') {
      throw new BadRequestException('status tiene que ser active o disabled');
    }
    await this.prisma.user.update({ where: { id }, data: { status } });
    return { id, status };
  }

  /**
   * Resetea el segundo factor de un compañero: el camino de recuperación que NO baja el
   * techo de nada (§4). Queda auditado por `PlatformGuard`.
   *
   * **Nadie se resetea a sí mismo.** Si se permitiera, quien robe una cookie viva de
   * plataforma se saltaría el segundo factor entero: entra, se lo resetea y enrola su
   * propio teléfono. El auto-servicio para «perdí el teléfono» son los códigos de
   * respaldo, que exigen tener uno.
   */
  async resetPlatformMfa(actorUserId: string, id: string) {
    const user = await this.mustPlatformUser(id);
    if (user.id === actorUserId) {
      throw new BadRequestException(
        'No puedes resetear tu propio segundo factor. Usa un código de respaldo, o pídeselo a otro admin de plataforma.',
      );
    }
    return this.mfa.reset(id);
  }

  private async mustPlatformUser(id: string) {
    const user = await this.prisma.user.findFirst({ where: { id, isPlatform: true } });
    if (!user) throw new NotFoundException('Usuario de plataforma no encontrado');
    return user;
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
