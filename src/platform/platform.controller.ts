import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PlatformService } from './platform.service';
import { PlatformGuard } from './platform.guard';
import { ErrorLogsService } from '../observability/error-logs.service';
import { MetricsNegocioService } from '../analytics/metrics-negocio.service';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

// Consola de plataforma (super-admin). Todo cross-tenant y auditado por el guard.
@UseGuards(PlatformGuard)
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly logs: ErrorLogsService,
    private readonly metrics: MetricsNegocioService,
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

  // Operación de la capa gratuita: sesiones WAHA de todos los tenants con su
  // estado y volumen del día. Sin secretos (ni api key ni baseUrl).
  @Get('waha-sessions')
  wahaSessions() {
    return this.platform.wahaSessions();
  }

  // Envíos masivos de todos los tenants, y el botón para parar uno. Es lo que el
  // operador necesita a las 2 a.m., cuando el problema ya está pasando.
  @Get('broadcasts')
  broadcasts(@Query('status') status?: string) {
    return this.platform.broadcasts(status || undefined);
  }

  // Carteras de todos los tenants. Una cartera enorme en un plan gratuito es la señal:
  // ahí solo entra quien escribió, así que un salto raro merece una mirada.
  @Get('contact-lists')
  contactLists() {
    return this.platform.contactLists();
  }

  @Patch('broadcasts/:id')
  cancelBroadcast(@Param('id') id: string, @Body() body: any) {
    return this.platform.cancelBroadcast(id, body);
  }

  // --- Usuarios de plataforma (§9) ------------------------------------------------------
  // Compañeros de revisión. Todos nacen con segundo factor OBLIGATORIO: `openSession` no
  // emite cookie sin él, así que aceptar la invitación cae directo al enrolamiento.

  @Get('users')
  listPlatformUsers() {
    return this.platform.listPlatformUsers();
  }

  /** Devuelve el enlace de invitación UNA vez: no hay correo saliente en este producto. */
  @Post('users')
  invitePlatformUser(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.platform.invitePlatformUser(user.userId, body);
  }

  @Patch('users/:id')
  updatePlatformUser(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.platform.updatePlatformUser(user.userId, id, body);
  }

  /** Recuperación de un compañero que perdió el teléfono. Nunca sobre uno mismo. */
  @Post('users/:id/reset-mfa')
  resetPlatformMfa(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.platform.resetPlatformMfa(user.userId, id);
  }

  // Agregados de negocio de un tenant (cross-tenant, auditado por el guard).
  @Get('tenants/:id/metrics-negocio')
  tenantMetrics(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.metrics.summary(id, { from, to });
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
