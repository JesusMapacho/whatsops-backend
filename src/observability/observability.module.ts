import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module';
import { ErrorLogsService } from './error-logs.service';
import { ErrorLogsController } from './error-logs.controller';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { RequestIdInterceptor } from './request-id.interceptor';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { MetricsInterceptor } from './metrics.interceptor';
import { PlatformOnlyGuard } from '../auth/platform-only.guard';

// APP_FILTER y APP_INTERCEPTOR se aplican globalmente aunque se declaren aquí.
// Los contadores de /metrics leen las colas vía PgBossService (global), no hace falta
// registrarlas aquí.
@Module({
  imports: [PrismaModule],
  controllers: [ErrorLogsController, MetricsController],
  providers: [
    ErrorLogsService,
    MetricsService,
    PlatformOnlyGuard,
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [ErrorLogsService],
})
export class ObservabilityModule {}
