import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesService } from '../../roles/roles.service';

// TTL corto a propósito (ver `SsoExchangeToken` en el schema): es una posta entre
// dos peticiones servidor-a-servidor y la navegación que sigue de inmediato, no
// una sesión — 60s sobra incluso con una red lenta y acota la ventana si el
// token se filtrara en un log de por medio.
const SSO_TOKEN_TTL_MS = 60_000;

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

/** Contraseña que nadie puede teclear: estas cuentas solo entran por SSO desde
 * el POS, salvo que su dueño use "olvidé mi contraseña" dentro del CRM — que
 * sigue siendo un sistema independiente y no pierde esa puerta. */
async function passwordInutilizable(): Promise<string> {
  return bcrypt.hash(randomBytes(32).toString('hex'), 10);
}

function nombre(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null;
}

@Injectable()
export class PosIntegrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RolesService,
  ) {}

  /**
   * Aprovisiona (o devuelve, si ya existe) el Tenant del CRM para una empresa
   * del POS. Idempotente por `posTenantId`: un reintento del lado del POS
   * (p.ej. tras un timeout) no duplica el tenant.
   */
  async provision(body: any) {
    const posTenantId = this.requerido(body?.posTenantId, 'posTenantId');
    const businessName = this.requerido(body?.businessName, 'businessName');
    const adminEmail = this.requeridoCorreo(body?.adminEmail);

    const existente = await this.prisma.posLink.findUnique({ where: { posTenantId } });
    if (existente) {
      return { crmTenantId: existente.tenantId, status: existente.status };
    }

    const passwordHash = await passwordInutilizable();
    const link = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({ data: { name: businessName } });
      const { adminRoleId } = await this.roles.ensureSystemRoles(tenant.id, tx);
      await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: adminEmail,
          passwordHash,
          role: 'admin',
          roleId: adminRoleId,
          firstName: nombre(body?.adminFirstName),
          lastName: nombre(body?.adminLastName),
          // El onboarding del CRM sigue su curso normal: aprovisionar la cuenta
          // no rellena el negocio por la persona, solo le abre la puerta.
        },
      });
      return tx.posLink.create({
        data: { tenantId: tenant.id, posTenantId, status: 'active' },
      });
    });

    return { crmTenantId: link.tenantId, status: link.status };
  }

  /**
   * Emite un token de un solo uso para abrir sesión como `email` dentro del
   * tenant vinculado a `posTenantId`. Crea al usuario si es la primera vez que
   * esa persona del POS abre el módulo CRM (rol `agent`) — no hace falta
   * sincronizar cada usuario del POS por adelantado.
   */
  async issueSsoToken(body: any) {
    const posTenantId = this.requerido(body?.posTenantId, 'posTenantId');
    const email = this.requeridoCorreo(body?.email);

    const link = await this.prisma.posLink.findUnique({ where: { posTenantId } });
    if (!link) throw new NotFoundException('Esta empresa del POS no tiene CRM vinculado');
    if (link.status !== 'active') throw new ForbiddenException('El acceso al CRM está suspendido');

    let user = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: link.tenantId, email } },
      select: { id: true },
    });
    if (!user) {
      const { agentRoleId } = await this.roles.ensureSystemRoles(link.tenantId);
      user = await this.prisma.user.create({
        data: {
          tenantId: link.tenantId,
          email,
          passwordHash: await passwordInutilizable(),
          role: 'agent',
          roleId: agentRoleId,
          firstName: nombre(body?.firstName),
          lastName: nombre(body?.lastName),
        },
        select: { id: true },
      });
    }

    const token = randomBytes(32).toString('base64url');
    await this.prisma.ssoExchangeToken.create({
      data: {
        tokenHash: sha256(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + SSO_TOKEN_TTL_MS),
      },
    });
    return { token };
  }

  private requerido(v: unknown, campo: string): string {
    if (typeof v !== 'string' || !v.trim()) {
      throw new BadRequestException(`Falta ${campo}`);
    }
    return v.trim();
  }

  private requeridoCorreo(v: unknown): string {
    const email = this.requerido(v, 'email').toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('email inválido');
    }
    return email;
  }
}
