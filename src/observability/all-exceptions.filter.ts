import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { esRutaDeHook, redact, redactPath } from './redact';

// Filtro global: ante CUALQUIER excepción persiste un ErrorLog (mejor esfuerzo,
// sin bloquear) y responde al cliente como lo haría Nest. Si el log falla, la
// API sigue respondiendo con normalidad.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorLog');

  constructor(private readonly prisma: PrismaService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = isHttp
      ? exception.getResponse()
      : { statusCode: status, message: 'Internal server error' };

    // Persistir el log sin await (no degrada la latencia de la respuesta).
    this.persist(req, exception, status).catch((e) =>
      this.logger.error(`No se pudo persistir ErrorLog: ${e?.message ?? e}`),
    );

    // Respuesta normal al cliente.
    if (!res?.status) return;
    res.status(status).json(typeof payload === 'string' ? { statusCode: status, message: payload } : payload);
  }

  private async persist(req: any, exception: unknown, status: number) {
    const err = exception as any;
    const message =
      (err?.response?.message && JSON.stringify(err.response.message)) ||
      err?.message ||
      'Error';
    await this.prisma.errorLog.create({
      data: {
        tenantId: req?.user?.tenantId ?? null,
        userId: req?.user?.userId ?? null,
        method: req?.method ?? 'UNKNOWN',
        path: redactPath((req?.originalUrl ?? req?.url ?? '').split('?')[0] || '/'),
        statusCode: status,
        // El cuerpo de un hook es PII de terceros que manda un sistema ajeno: mismo criterio
        // que el CSV de un envío masivo (ver `redact.ts`), no acaba en un log de plataforma.
        requestBody: esRutaDeHook((req?.originalUrl ?? req?.url ?? '').split('?')[0] || '/')
          ? null
          : sanitizeJson(redact(req?.body)),
        query: sanitizeJson(redact(req?.query)),
        errorMessage: String(message).slice(0, 2000),
        errorCode: err?.code ? String(err.code) : null,
        stack: err?.stack ? String(err.stack).slice(0, 8000) : null,
        requestId: req?.requestId ?? 'no-request-id',
      },
    });
  }
}

// Prisma Json no acepta undefined; normaliza a null.
function sanitizeJson(v: unknown) {
  return v === undefined ? null : (v as any);
}
