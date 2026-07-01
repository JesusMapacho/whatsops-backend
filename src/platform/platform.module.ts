import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ObservabilityModule } from '../observability/observability.module';
import { PlatformService } from './platform.service';
import { PlatformController } from './platform.controller';
import { PlatformGuard } from './platform.guard';

@Module({
  imports: [PrismaModule, ObservabilityModule],
  controllers: [PlatformController],
  providers: [PlatformService, PlatformGuard],
})
export class PlatformModule {}
