import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { PgBossModule } from './queue/pgboss.module';
import { HealthController } from './health/health.controller';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { InvitationsModule } from './invitations/invitations.module';
import { WabaModule } from './waba/waba.module';
import { EventsModule } from './events/events.module';
import { WebhookModule } from './webhook/webhook.module';
import { MessagingModule } from './messaging/messaging.module';
import { ContactsModule } from './contacts/contacts.module';
import { CrmModule } from './crm/crm.module';
import { RolesModule } from './roles/roles.module';
import { ObservabilityModule } from './observability/observability.module';
import { PlatformModule } from './platform/platform.module';
import { BillingModule } from './billing/billing.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ProfileModule } from './profile/profile.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { AssistantModule } from './assistant/assistant.module';
import { BrandingModule } from './branding/branding.module';
import { WahaModule } from './waha/waha.module';
import { AutomationsModule } from './automations/automations.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { CsrfGuard } from './auth/csrf.guard';
import { RolesGuard } from './auth/roles.guard';
import { PermissionsGuard } from './auth/permissions.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    PgBossModule,
    AuthModule,
    UsersModule,
    InvitationsModule,
    WabaModule,
    EventsModule,
    WebhookModule,
    MessagingModule,
    ContactsModule,
    CrmModule,
    RolesModule,
    ObservabilityModule,
    PlatformModule,
    BillingModule,
    AnalyticsModule,
    ProfileModule,
    OnboardingModule,
    AssistantModule,
    BrandingModule,
    WahaModule,
    AutomationsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Orden importa: primero autentica (pone req.user), luego rol, luego permiso.
    // El CSRF va tras autenticar a propósito: así una petición sin sesión da 401 (que es
    // lo que pasa) y no un 403 de token que despista al depurar.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
