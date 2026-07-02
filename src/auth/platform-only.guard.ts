import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from './current-user.decorator';

// Solo super-admin de plataforma (isPlatform). Verifica contra la DB por request
// (refleja bajas al instante). Ligero: no audita ni depende del módulo platform,
// por eso no crea el ciclo observability↔platform que sí traería PlatformGuard.
@Injectable()
export class PlatformOnlyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
    if (!user) throw new ForbiddenException('No autenticado');
    const row = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { isPlatform: true },
    });
    if (!row?.isPlatform) throw new ForbiddenException('Requiere super-admin');
    return true;
  }
}
