import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PlatformService } from './platform.service';
import { PlatformGuard } from './platform.guard';
import { ErrorLogsService } from '../observability/error-logs.service';

// Consola de plataforma (super-admin). Todo cross-tenant y auditado por el guard.
@UseGuards(PlatformGuard)
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly logs: ErrorLogsService,
  ) {}

  @Get('tenants')
  listTenants(@Query('search') search?: string) {
    return this.platform.listTenants(search || undefined);
  }

  @Get('tenants/:id')
  getTenant(@Param('id') id: string) {
    return this.platform.getTenant(id);
  }

  @Patch('tenants/:id')
  updateTenant(@Param('id') id: string, @Body() body: any) {
    return this.platform.updateTenant(id, body);
  }

  // Auditoría cross-tenant: consume los logs de la feature 05 (errores + accesos
  // del super-admin), filtrable por tenant/usuario/estado/fecha.
  @Get('audit')
  audit(
    @Query('tenantId') tenantId?: string,
    @Query('userId') userId?: string,
    @Query('statusCode') statusCode?: string,
    @Query('path') path?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('text') text?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    // tenantId opcional: null = todos los tenants (privilegio de plataforma).
    return this.logs.list(
      tenantId || null,
      {
        userId: userId || undefined,
        statusCode: statusCode ? Number(statusCode) : undefined,
        path: path || undefined,
        from: parseDate(from),
        to: parseDate(to),
        text: text || undefined,
      },
      limit ? Number(limit) : undefined,
      before,
    );
  }
}

function parseDate(v?: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}
