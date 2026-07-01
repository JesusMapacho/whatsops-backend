import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { randomBytes } from 'node:crypto';
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
    const users = await this.prisma.user.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });
    return users.map((u) => this.toPublic(u));
  }

  // Cambiar rol (roleId), estado y datos básicos. El super-admin (isPlatform)
  // nunca es asignable/editable desde aquí (gestión de tenant, feature 02).
  async update(tenantId: string, id: string, body: any) {
    const user = await this.mustFind(tenantId, id);
    const data: any = {};

    if (body?.roleId !== undefined) {
      const role = await this.prisma.role.findFirst({
        where: { id: body.roleId, tenantId },
        select: { id: true, name: true, isSystem: true },
      });
      if (!role) throw new BadRequestException('roleId inválido para este tenant');
      data.roleId = role.id;
      // Mantener el enum como espejo: solo el rol de sistema admin da bypass.
      data.role = role.isSystem && role.name === 'admin' ? 'admin' : 'agent';
    }

    if (body?.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'disabled') {
        throw new BadRequestException('status debe ser active|disabled');
      }
      data.status = body.status;
    }

    if (typeof body?.email === 'string' && body.email.trim()) {
      validateCredentials(body.email, 'placeholder8'); // valida formato de email
      data.email = body.email.toLowerCase();
    }

    try {
      const updated = await this.prisma.user.update({ where: { id: user.id }, data });
      return this.toPublic(updated);
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException('El email ya existe en este tenant');
      throw e;
    }
  }

  // Password temporal (el usuario la cambia después). Devuelve el valor en claro
  // UNA vez; en DB solo vive el hash.
  async resetPassword(tenantId: string, id: string) {
    const user = await this.mustFind(tenantId, id);
    const tempPassword = randomBytes(9).toString('base64url'); // 12 chars, >= 8
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    return { tempPassword };
  }

  // Borrar solo si nunca tuvo actividad; si tuvo, desactivar (conserva atribución).
  async remove(tenantId: string, id: string) {
    const user = await this.mustFind(tenantId, id);
    const [convs, notes] = await Promise.all([
      this.prisma.conversation.count({ where: { tenantId, assignedUserId: id } }),
      this.prisma.note.count({ where: { tenantId, authorId: id } }),
    ]);
    if (convs > 0 || notes > 0) {
      throw new BadRequestException('El usuario tiene actividad; desactívalo en vez de borrarlo');
    }
    await this.prisma.user.delete({ where: { id: user.id } });
    return { deleted: true };
  }

  private async mustFind(tenantId: string, id: string) {
    const user = await this.prisma.user.findFirst({ where: { id, tenantId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    // El guard de super-admin (isPlatform) se añade en feature 03.
    return user;
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

  private toPublic(u: {
    id: string;
    email: string;
    role: UserRole;
    roleId?: string | null;
    status?: string;
    tenantId: string;
  }) {
    return {
      id: u.id,
      email: u.email,
      role: u.role,
      roleId: u.roleId ?? null,
      status: u.status ?? 'active',
      tenantId: u.tenantId,
    };
  }
}
