import { ConflictException, Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { validateCredentials } from '../auth/validate';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  // Todo filtrado por tenantId: ninguna query cruza tenants.
  async create(tenantId: string, body: any) {
    const { email, password } = validateCredentials(body?.email, body?.password);
    const role: UserRole = body?.role === 'admin' ? 'admin' : 'agent';
    const passwordHash = await bcrypt.hash(password, 10);
    try {
      const user = await this.prisma.user.create({
        data: { tenantId, email, passwordHash, role },
      });
      return this.toPublic(user);
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new ConflictException('El email ya existe en este tenant');
      }
      throw e;
    }
  }

  async list(tenantId: string) {
    const users = await this.prisma.user.findMany({ where: { tenantId } });
    return users.map((u) => this.toPublic(u));
  }

  private toPublic(u: { id: string; email: string; role: UserRole; tenantId: string }) {
    return { id: u.id, email: u.email, role: u.role, tenantId: u.tenantId };
  }
}
