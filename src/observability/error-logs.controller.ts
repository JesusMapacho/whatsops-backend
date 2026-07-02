import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ErrorLogsService } from './error-logs.service';
import { PlatformOnlyGuard } from '../auth/platform-only.guard';

// Consola de errores de la API: SOLO super-admin (ve TODOS los tenants). El admin
// de tenant no ve error-logs; su auditoría es la de webhooks (webhook-events).
@UseGuards(PlatformOnlyGuard)
@Controller('error-logs')
export class ErrorLogsController {
  constructor(private readonly logs: ErrorLogsService) {}

  // Rutas distintas presentes en los logs, para poblar el select de filtro.
  @Get('paths')
  paths() {
    return this.logs.paths();
  }

  @Get()
  list(
    @Query('statusCode') statusCode?: string,
    @Query('path') path?: string,
    @Query('userId') userId?: string,
    @Query('email') email?: string,
    @Query('tenantId') tenantId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('text') text?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    // null = todos los tenants; el filtro tenantId lo acota si se pide.
    return this.logs.list(
      null,
      {
        statusCode: statusCode ? Number(statusCode) : undefined,
        path: path || undefined,
        userId: userId || undefined,
        email: email || undefined,
        tenantId: tenantId || undefined,
        from: parseDate(from),
        to: parseDate(to),
        text: text || undefined,
        excludeAudit: true, // la consola muestra errores reales, no filas de auditoría de plataforma
      },
      limit ? Number(limit) : undefined,
      before,
    );
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.logs.get(null, id);
  }
}

function parseDate(v?: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}
