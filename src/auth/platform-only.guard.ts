import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErrorLogsService } from '../observability/error-logs.service';
import { AuthUser } from './current-user.decorator';

// Solo super-admin de plataforma (isPlatform). Verifica contra la DB por request
// (refleja bajas al instante). Sigue sin depender del módulo platform, así que no crea el
// ciclo observability↔platform que sí traería PlatformGuard.
//
// **Y ahora audita.** Antes no lo hacía, y era el hueco más grande del rastro: protege
// `/error-logs/*`, que lee con `tenantId: null` —o sea los ErrorLog de TODOS los clientes,
// con `requestBody` y `query` dentro—. Era la lectura cross-tenant más sensible del
// producto y la única que no dejaba una sola fila. `ErrorLogsService` vive en el mismo
// módulo que registra este guard, así que no hay ciclo: no importa nada de `auth`.
@Injectable()
export class PlatformOnlyGuard implements CanActivate {
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

    // Misma forma y mismo criterio que `PlatformGuard`: fire-and-forget, para que un fallo
    // de auditoría no tumbe la petición.
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0] || '/';
    void this.audit.audit({
      actorUserId: user.userId,
      // Estas rutas no llevan tenant: leen cross-tenant por definición.
      tenantId: null,
      method: req.method,
      path,
      action: `super-admin ${req.method} ${path}`,
      requestId: req.requestId,
    });
    return true;
  }
}
