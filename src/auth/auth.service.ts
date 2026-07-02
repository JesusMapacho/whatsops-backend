import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { RolesService } from '../roles/roles.service';
import { AuthUser } from './current-user.decorator';
import { validateCredentials } from './validate';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly roles: RolesService,
  ) {}

  // Registro: crea Tenant + primer User admin en una transacción.
  async register(body: any) {
    const { email, password } = validateCredentials(body?.email, body?.password);
    const tenantName =
      typeof body?.tenantName === 'string' && body.tenantName.trim()
        ? body.tenantName.trim()
        : email;
    const passwordHash = await bcrypt.hash(password, 10);

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({ data: { name: tenantName } });
        // Siembra roles de sistema del nuevo tenant y asigna admin al primer user.
        const { adminRoleId } = await this.roles.ensureSystemRoles(tenant.id, tx);
        return tx.user.create({
          data: {
            tenantId: tenant.id,
            email,
            passwordHash,
            role: 'admin',
            roleId: adminRoleId,
          },
        });
      });
      // Tenant recién creado: onboarding pendiente.
      return this.sign(user.id, user.tenantId, user.role, user.roleId, false);
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new ConflictException('El email ya está registrado');
      }
      throw e;
    }
  }

  async login(body: any) {
    const { email, password } = validateCredentials(body?.email, body?.password);
    // Sin tenant en login: el email es único globalmente en la práctica del MVP.
    // ponytail: findFirst por email; si dos tenants comparten email, añadir
    // selector de tenant en login.
    const user = await this.prisma.user.findFirst({
      where: { email },
      include: { tenant: { select: { status: true, onboardingComplete: true } } },
    });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Credenciales inválidas');
    }
    // Un usuario desactivado no puede loguear (conserva su atribución).
    if (user.status === 'disabled') {
      throw new UnauthorizedException('Usuario desactivado');
    }
    // Tenant suspendido: sus usuarios no operan (el super-admin no lo está).
    if (user.tenant?.status === 'suspended') {
      throw new UnauthorizedException('Tenant suspendido');
    }
    return this.sign(
      user.id,
      user.tenantId,
      user.role,
      user.roleId,
      user.tenant?.onboardingComplete ?? true,
    );
  }

  async me(auth: AuthUser) {
    const user = await this.prisma.user.findUnique({
      where: { id: auth.userId },
      select: {
        id: true,
        email: true,
        role: true,
        roleId: true,
        status: true,
        isPlatform: true,
        tenantId: true,
        firstName: true,
        lastName: true,
        emailVerified: true,
        phoneVerified: true,
        tenant: { select: { onboardingComplete: true } },
      },
    });
    if (!user) throw new UnauthorizedException('Usuario no encontrado');
    const permissions = await this.roles.permissionKeysFor(user.role, user.roleId);
    const { tenant, ...rest } = user;
    return { ...rest, onboardingComplete: tenant?.onboardingComplete ?? true, permissions };
  }

  private async sign(
    userId: string,
    tenantId: string,
    role: string,
    roleId: string | null,
    onboardingComplete: boolean,
  ) {
    const accessToken = await this.jwt.signAsync({ sub: userId, tenantId, role, roleId });
    return {
      accessToken,
      user: { id: userId, tenantId, role, roleId, onboardingComplete },
    };
  }
}
