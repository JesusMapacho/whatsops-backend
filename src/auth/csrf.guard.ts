// CSRF de doble envío (v6 feature 31). Con la sesión en cookie, el navegador la adjunta
// solo en cada petición al dominio — y esa es justo la propiedad que explota el CSRF:
// una página cualquiera provoca un POST a nuestra API con la sesión del usuario. La
// cookie legible `wo_csrf` la puede leer nuestro frontend y copiarla en el header; otro
// origen no puede leerla, así que no sabe qué mandar.
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from './public.decorator';
import { CSRF_COOKIE, CSRF_HEADER, readCookie } from './session-cookie';

const MUTA = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * La decisión, sin Nest alrededor, para que el check no tenga que fabricar un
 * ExecutionContext. `headers` es el objeto de Node: nombres en minúscula.
 */
export function csrfAllowed(
  isPublic: boolean,
  method: string,
  headers: Record<string, unknown>,
): boolean {
  // Las rutas públicas quedan fuera: el webhook (`webhook.controller.ts`) se autentica
  // por firma HMAC y no tiene cookie que robar, y en login/registro todavía no hay sesión
  // que un tercero pueda usar.
  if (isPublic) return true;
  if (!MUTA.has(method.toUpperCase())) return true;
  const enviado = headers[CSRF_HEADER];
  const cookie = readCookie(headers.cookie as string | undefined, CSRF_COOKIE);
  return !!cookie && typeof enviado === 'string' && enviado === cookie;
}

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    // El handshake del socket no es una petición con formulario; su auth se resuelve en
    // `events.gateway.ts` y un `emit` no lo provoca una página ajena.
    if (ctx.getType() !== 'http') return true;
    const isPublic = !!this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const req = ctx.switchToHttp().getRequest();
    if (csrfAllowed(isPublic, req.method ?? 'GET', req.headers ?? {})) return true;
    throw new ForbiddenException('Falta o no coincide el token CSRF');
  }
}
