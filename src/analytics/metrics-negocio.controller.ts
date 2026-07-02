import { Controller, Get, Query } from '@nestjs/common';
import { MetricsNegocioService } from './metrics-negocio.service';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

// Panel de negoc­io del tenant (agregados). Distinto del /metrics técnico de
// Prometheus (feature 06). El admin ve el tenant completo; un agente solo sus
// propias métricas (conversaciones asignadas a él).
@Controller('metrics-negocio')
export class MetricsNegocioController {
  constructor(private readonly metrics: MetricsNegocioService) {}

  @Get()
  summary(@CurrentUser() user: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    const assignedUserId = user.role === 'admin' ? undefined : user.userId;
    return this.metrics.summary(user.tenantId, { from, to }, assignedUserId);
  }
}
