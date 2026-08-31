import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { RolesModule } from '../../roles/roles.module';
import { PosIntegrationController } from './pos-integration.controller';
import { PosIntegrationService } from './pos-integration.service';
import { PosServiceGuard } from './pos-service.guard';

@Module({
  imports: [PrismaModule, RolesModule],
  controllers: [PosIntegrationController],
  providers: [PosIntegrationService, PosServiceGuard],
})
export class PosIntegrationModule {}
