import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from './current-user.decorator';
import { PERMISSIONS_KEY } from './permissions.decorator';
import { PermissionKey } from './permissions.catalog';

// Guard global (tras JwtAuthGuard). Resuelve los permisos del rol del usuario
// EN DB por request: quitar un permiso revoca el acceso en la siguiente petición
// (no se cachea en el JWT). El admin de sistema (enum) tiene todos los permisos.
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionKey[]>(
      PERMISSIONS_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required?.length) return true;

    const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
    if (!user) throw new ForbiddenException('No autenticado');

    // El admin de sistema conserva acceso total (compatibilidad v1).
    if (user.role === 'admin') return true;

    const granted = await this.resolvePermissions(user);
    const ok = required.every((p) => granted.has(p));
    if (!ok) throw new ForbiddenException('Permiso insuficiente');
    return true;
  }

  private async resolvePermissions(user: AuthUser): Promise<Set<string>> {
    // roleId del JWT si viene; si no (token viejo), se busca por userId.
    let roleId = user.roleId ?? null;
    if (!roleId) {
      const u = await this.prisma.user.findUnique({
        where: { id: user.userId },
        select: { roleId: true },
      });
      roleId = u?.roleId ?? null;
    }
    if (!roleId) return new Set();

    const rows = await this.prisma.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: { key: true } } },
    });
    return new Set(rows.map((r) => r.permission.key));
  }
}
