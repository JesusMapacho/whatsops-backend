import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { HealthController } from './health/health.controller';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { WabaModule } from './waba/waba.module';
import { EventsModule } from './events/events.module';
import { WebhookModule } from './webhook/webhook.module';
import { MessagingModule } from './messaging/messaging.module';
import { RolesModule } from './roles/roles.module';
import { ObservabilityModule } from './observability/observability.module';
import { PlatformModule } from './platform/platform.module';
import { BillingModule } from './billing/billing.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ProfileModule } from './profile/profile.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { AssistantModule } from './assistant/assistant.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { PermissionsGuard } from './auth/permissions.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      // Pasamos opciones (no una instancia): BullMQ crea su propio cliente ioredis
      // y evita el choque de tipos entre dos copias del paquete.
      useFactory: (config: ConfigService) => {
        const u = new URL(config.get<string>('REDIS_URL')!);
        return {
          connection: {
            host: u.hostname,
            port: Number(u.port || 6379),
            username: u.username || undefined,
            password: u.password || undefined,
          },
        };
      },
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    WabaModule,
    EventsModule,
    WebhookModule,
    MessagingModule,
    RolesModule,
    ObservabilityModule,
    PlatformModule,
    BillingModule,
    AnalyticsModule,
    ProfileModule,
    OnboardingModule,
    AssistantModule,
  ],
  controllers: [HealthController],
  providers: [
    // Orden importa: primero autentica (pone req.user), luego rol, luego permiso.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
