import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

export const POS_SERVICE_HEADER = 'x-service-token';

/**
 * Puerta de las rutas servicio-a-servicio del puente con el POS
 * (`/api/integrations/pos/*`). No hay `req.user` aquí: quien llama es
 * `POS_SERVER`, no un navegador con sesión, así que no compara contra la
 * tabla `User` como `PlatformOnlyGuard` — compara un secreto compartido.
 *
 * `timingSafeEqual` exige la misma longitud, así que se compara primero el
 * tamaño (con `!==` normal, que no filtra nada explotable: la longitud del
 * secreto no es el secreto) antes de la comparación de tiempo constante.
 */
@Injectable()
export class PosServiceGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const recibido = req.headers[POS_SERVICE_HEADER];
    const esperado = this.config.get<string>('POS_SERVICE_SECRET') ?? '';

    if (typeof recibido !== 'string' || !esperado) {
      throw new UnauthorizedException('Falta el token de servicio');
    }

    const a = Buffer.from(recibido);
    const b = Buffer.from(esperado);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Token de servicio inválido');
    }
    return true;
  }
}
