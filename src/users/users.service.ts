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
    // Mapea el enum al rol de sistema del tenant para poblar roleId (RBAC).
    const roleId = await this.systemRoleId(tenantId, role);
    try {
      const user = await this.prisma.user.create({
        data: { tenantId, email, passwordHash, role, roleId },
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

  // roleId del rol de sistema (admin|agent) del tenant. Los roles se aseguran al
  // arrancar y al registrar el tenant, así que normalmente existen.
  private async systemRoleId(tenantId: string, name: UserRole): Promise<string | null> {
    const role = await this.prisma.role.findUnique({
      where: { tenantId_name: { tenantId, name } },
      select: { id: true },
    });
    return role?.id ?? null;
  }

  private toPublic(u: { id: string; email: string; role: UserRole; tenantId: string }) {
    return { id: u.id, email: u.email, role: u.role, tenantId: u.tenantId };
  }
}
