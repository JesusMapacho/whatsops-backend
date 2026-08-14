import { Controller, Get, Query } from '@nestjs/common';
import { MetricsNegocioService } from './metrics-negocio.service';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { RequirePermissions } from '../auth/permissions.decorator';

// Panel de negoc­io del tenant (agregados). Distinto del /metrics técnico de
// Prometheus (feature 06). El admin ve el tenant completo; un agente solo sus
// propias métricas (conversaciones asignadas a él).
@Controller('metrics-negocio')
export class MetricsNegocioController {
  constructor(private readonly metrics: MetricsNegocioService) {}

  /**
   * `analytics:read` estaba en el catálogo desde el lote admin y **no se exigía en ningún
   * sitio**: el constructor de roles enseñaba la casilla «Ver métricas» y desmarcarla no hacía
   * nada. Aquí empieza a hacer lo que dice.
   *
   * Las dos capas siguen separadas, como en el resto del producto: el **permiso** dice si
   * puedes abrir el panel, y el **alcance** de abajo qué filas ves — el admin las del tenant,
   * cualquier otro solo sus conversaciones. Que tengas el permiso no te da los datos de nadie.
   */
  @Get()
  @RequirePermissions('analytics:read')
  summary(@CurrentUser() user: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    const assignedUserId = user.role === 'admin' ? undefined : user.userId;
    return this.metrics.summary(user.tenantId, { from, to }, assignedUserId);
  }
}
