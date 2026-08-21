import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ObservabilityModule } from '../observability/observability.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { RolesModule } from '../roles/roles.module';
import { AuthModule } from '../auth/auth.module';
import { InvitationsModule } from '../invitations/invitations.module';
import { PlatformService } from './platform.service';
import { PlatformController } from './platform.controller';
import { PlatformGuard } from './platform.guard';

@Module({
  // RolesModule: sembrar los roles de sistema del tenant de plataforma en el PRIMER
  // arranque. AuthModule: `MfaService`, para que un admin de plataforma pueda resetear el
  // segundo factor de un compañero y quede auditado por `PlatformGuard`.
  imports: [
    PrismaModule,
    ObservabilityModule,
    AnalyticsModule,
    RolesModule,
    AuthModule,
    InvitationsModule,
  ],
  controllers: [PlatformController],
  providers: [PlatformService, PlatformGuard],
})
export class PlatformModule {}
