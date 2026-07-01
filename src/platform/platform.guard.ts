import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErrorLogsService } from '../observability/error-logs.service';
import { AuthUser } from '../auth/current-user.decorator';

// Guard dedicado del super-admin: ÚNICA vía autorizada para cruzar tenants.
// Verifica isPlatform contra la DB (no confía solo en el JWT: refleja bajas al
// instante) y AUDITA cada acceso cross-tenant (feature 05). Excepción explícita
// y acotada al aislamiento por tenant de CLAUDE.md.
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ErrorLogsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const user: AuthUser | undefined = req.user;
    if (!user) throw new ForbiddenException('No autenticado');

    const row = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { isPlatform: true },
    });
    if (!row?.isPlatform) throw new ForbiddenException('Requiere super-admin');

    // Auditar el acceso cross-tenant (quién, qué, sobre qué tenant, cuándo).
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0] || '/';
    void this.audit.audit({
      actorUserId: user.userId,
      tenantId: req.params?.id ?? null,
      method: req.method,
      path,
      action: `super-admin ${req.method} ${path}`,
      requestId: req.requestId,
    });
    return true;
  }
}
