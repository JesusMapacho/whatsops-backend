import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

// Registra latencia/throughput/errores por request. La etiqueta `route` usa el
// patrón de ruta (p. ej. /users/:id), NUNCA la URL con IDs concretos, para
// acotar la cardinalidad.
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest();
    const res = ctx.switchToHttp().getResponse();
    const start = process.hrtime.bigint();

    const record = () => {
      const route = req.route?.path ?? this.normalize(req.path ?? req.url ?? '/');
      const tenant = req.user?.tenantId ?? 'anon';
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.metrics.observe(req.method, route, res.statusCode ?? 0, tenant, seconds);
    };

    return next.handle().pipe(
      tap({
        next: () => record(),
        // En error, el filtro global ya fijó el status; medimos igual.
        error: () => record(),
      }),
    );
  }

  // Colapsa segmentos que parezcan IDs para no explotar la cardinalidad cuando
  // no hay patrón de ruta (rutas no resueltas / 404).
  private normalize(path: string): string {
    return path.split('?')[0].replace(/\/[0-9a-f]{8,}|\/\d+/gi, '/:id') || '/';
  }
}
