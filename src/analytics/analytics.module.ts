import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MetricsNegocioService } from './metrics-negocio.service';
import { MetricsNegocioController } from './metrics-negocio.controller';

@Module({
  imports: [PrismaModule],
  controllers: [MetricsNegocioController],
  providers: [MetricsNegocioService],
  exports: [MetricsNegocioService],
})
export class AnalyticsModule {}
