import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  PERMISSIONS,
  PermissionKey,
  SYSTEM_ROLE_PERMISSIONS,
} from '../auth/permissions.catalog';

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class RolesService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  // Al arrancar: siembra el catálogo de permisos, asegura los roles de sistema
  // de cada tenant existente y rellena User.roleId desde el enum. Idempotente:
  // no rompe sesiones ni datos si ya existen.
  async onModuleInit() {
    await this.seedCatalog();
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    for (const t of tenants) {
      const { adminRoleId, agentRoleId } = await this.ensureSystemRoles(t.id);
      await this.prisma.user.updateMany({
        where: { tenantId: t.id, roleId: null, role: 'admin' },
        data: { roleId: adminRoleId },
      });
      await this.prisma.user.updateMany({
        where: { tenantId: t.id, roleId: null, role: 'agent' },
        data: { roleId: agentRoleId },
      });
    }
  }

  async seedCatalog(db: Db = this.prisma) {
    for (const key of PERMISSIONS) {
      await db.permission.upsert({
        where: { key },
        create: { key },
        update: {},
      });
    }
  }

  // Crea/asegura los roles admin y agent (isSystem) del tenant con sus permisos.
  async ensureSystemRoles(
    tenantId: string,
    db: Db = this.prisma,
  ): Promise<{ adminRoleId: string; agentRoleId: string }> {
    const admin = await this.ensureRole(db, tenantId, 'admin', SYSTEM_ROLE_PERMISSIONS.admin);
    const agent = await this.ensureRole(db, tenantId, 'agent', SYSTEM_ROLE_PERMISSIONS.agent);
    return { adminRoleId: admin, agentRoleId: agent };
  }

  private async ensureRole(
    db: Db,
    tenantId: string,
    name: string,
    permKeys: PermissionKey[],
  ): Promise<string> {
    const role = await db.role.upsert({
      where: { tenantId_name: { tenantId, name } },
      create: { tenantId, name, isSystem: true },
      update: {},
    });
    const perms = await db.permission.findMany({
      where: { key: { in: permKeys } },
      select: { id: true },
    });
    await db.rolePermission.createMany({
      data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true,
    });
    return role.id;
  }

  // Permisos efectivos de un usuario (admin de sistema = todos).
  async permissionKeysFor(role: string, roleId: string | null): Promise<string[]> {
    if (role === 'admin') return [...PERMISSIONS];
    if (!roleId) return [];
    const rows = await this.prisma.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: { key: true } } },
    });
    return rows.map((r) => r.permission.key);
  }

  // --- API de administración (scoped por tenant) ---

  listCatalog() {
    return PERMISSIONS.map((key) => ({ key }));
  }

  async list(tenantId: string) {
    const roles = await this.prisma.role.findMany({
      where: { tenantId },
      include: { permissions: { select: { permission: { select: { key: true } } } } },
      orderBy: { name: 'asc' },
    });
    return roles.map((r) => this.toPublic(r));
  }

  async create(tenantId: string, body: any) {
    const name = String(body?.name ?? '').trim();
    if (!name) throw new BadRequestException('name requerido');
    const permKeys: string[] = Array.isArray(body?.permissions) ? body.permissions : [];
    try {
      const role = await this.prisma.role.create({
        data: { tenantId, name, isSystem: false },
      });
      if (permKeys.length) await this.replacePermissions(tenantId, role.id, permKeys);
      return this.get(tenantId, role.id);
    } catch (e: any) {
      if (e?.code === 'P2002') throw new BadRequestException('Ya existe un rol con ese nombre');
      throw e;
    }
  }

  async get(tenantId: string, id: string) {
    const role = await this.prisma.role.findFirst({
      where: { id, tenantId },
      include: { permissions: { select: { permission: { select: { key: true } } } } },
    });
    if (!role) throw new NotFoundException('Rol no encontrado');
    return this.toPublic(role);
  }

  async update(tenantId: string, id: string, body: any) {
    const role = await this.prisma.role.findFirst({ where: { id, tenantId } });
    if (!role) throw new NotFoundException('Rol no encontrado');
    if (role.isSystem && body?.name) {
      throw new ForbiddenException('No se puede renombrar un rol de sistema');
    }
    const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
    if (name) {
      try {
        await this.prisma.role.update({ where: { id }, data: { name } });
      } catch (e: any) {
        if (e?.code === 'P2002') throw new BadRequestException('Nombre de rol duplicado');
        throw e;
      }
    }
    return this.get(tenantId, id);
  }

  async remove(tenantId: string, id: string) {
    const role = await this.prisma.role.findFirst({ where: { id, tenantId } });
    if (!role) throw new NotFoundException('Rol no encontrado');
    if (role.isSystem) throw new ForbiddenException('No se puede borrar un rol de sistema');
    const inUse = await this.prisma.user.count({ where: { tenantId, roleId: id } });
    if (inUse) throw new BadRequestException('El rol está asignado a usuarios');
    await this.prisma.role.delete({ where: { id } });
    return { deleted: true };
  }

  async setPermissions(tenantId: string, id: string, body: any) {
    const role = await this.prisma.role.findFirst({ where: { id, tenantId } });
    if (!role) throw new NotFoundException('Rol no encontrado');
    const permKeys: string[] = Array.isArray(body?.permissions) ? body.permissions : [];
    await this.replacePermissions(tenantId, id, permKeys);
    return this.get(tenantId, id);
  }

  // Valida contra el catálogo y reemplaza el set de permisos del rol.
  private async replacePermissions(tenantId: string, roleId: string, permKeys: string[]) {
    const valid = new Set<string>(PERMISSIONS);
    const unknown = permKeys.filter((k) => !valid.has(k));
    if (unknown.length) throw new BadRequestException(`Permisos desconocidos: ${unknown.join(', ')}`);
    const perms = await this.prisma.permission.findMany({
      where: { key: { in: permKeys } },
      select: { id: true },
    });
    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { roleId } }),
      this.prisma.rolePermission.createMany({
        data: perms.map((p) => ({ roleId, permissionId: p.id })),
        skipDuplicates: true,
      }),
    ]);
  }

  private toPublic(role: {
    id: string;
    name: string;
    isSystem: boolean;
    tenantId: string;
    permissions: { permission: { key: string } }[];
  }) {
    return {
      id: role.id,
      name: role.name,
      isSystem: role.isSystem,
      tenantId: role.tenantId,
      permissions: role.permissions.map((p) => p.permission.key),
    };
  }
}
