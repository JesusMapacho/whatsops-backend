import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { validateCredentials } from './validate';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
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
        return tx.user.create({
          data: { tenantId: tenant.id, email, passwordHash, role: 'admin' },
        });
      });
      return this.sign(user.id, user.tenantId, user.role);
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
    const user = await this.prisma.user.findFirst({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Credenciales inválidas');
    }
    return this.sign(user.id, user.tenantId, user.role);
  }

  private async sign(userId: string, tenantId: string, role: string) {
    const accessToken = await this.jwt.signAsync({ sub: userId, tenantId, role });
    return { accessToken, user: { id: userId, tenantId, role } };
  }
}
