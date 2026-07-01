import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';

// Correlación: asigna un requestId por petición (req.requestId) y lo devuelve
// en la cabecera x-request-id. Lo consume el filtro de excepciones (feature 05).
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();
    const id = req.headers['x-request-id'] || randomUUID();
    req.requestId = id;
    if (res?.setHeader) res.setHeader('x-request-id', id);
    return next.handle();
  }
}
