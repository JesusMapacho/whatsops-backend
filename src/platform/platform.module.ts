import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ObservabilityModule } from '../observability/observability.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { PlatformService } from './platform.service';
import { PlatformController } from './platform.controller';
import { PlatformGuard } from './platform.guard';

@Module({
  imports: [PrismaModule, ObservabilityModule, AnalyticsModule],
  controllers: [PlatformController],
  providers: [PlatformService, PlatformGuard],
})
export class PlatformModule {}
