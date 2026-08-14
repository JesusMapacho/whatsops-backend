import { Body, Controller, Get, Patch } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { RequirePermissions } from '../auth/permissions.decorator';
import { KpisService } from './kpis.service';

// Ajustes del CRM y KPIs comerciales (v8 feature 38).
//
// Se guardan con `deals:read` y no con `analytics:read`, que es lo que pedía la spec: ese
// permiso NO está en el rol `agent`, y la misma spec dice que el agente ve estos números de sus
// tratos — con `analytics:read` no vería nada. `deals:read` es literalmente "ve el embudo", que
// es el permiso que corresponde a unos números sobre tratos.
@Controller('crm')
export class KpisController {
  constructor(private readonly kpis: KpisService) {}

  @Get('kpis')
  @RequirePermissions('deals:read')
  resumen(@CurrentUser() user: AuthUser) {
    return this.kpis.resumen(user.tenantId, user.userId, user.role);
  }

  @Get('ajustes')
  @RequirePermissions('deals:read')
  ajustes(@CurrentUser() user: AuthUser) {
    return this.kpis.ajustes(user.tenantId);
  }

  // Encender el alta automática crea filas solas, así que es de quien configura el embudo.
  @Patch('ajustes')
  @RequirePermissions('deals:manage')
  guardar(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.kpis.guardarAjustes(user.tenantId, body);
  }
}
