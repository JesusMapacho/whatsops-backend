import { Controller, Get, Query } from '@nestjs/common';
import { MetricsNegocioService } from './metrics-negocio.service';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

// Panel de negoc­io del tenant (agregados). Distinto del /metrics técnico de
// Prometheus (feature 06).
@Controller('metrics-negocio')
export class MetricsNegocioController {
  constructor(private readonly metrics: MetricsNegocioService) {}

  @RequirePermissions('analytics:read')
  @Get()
  summary(@CurrentUser() user: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    return this.metrics.summary(user.tenantId, { from, to });
  }
}
