import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../events/events.module';
import { CryptoModule } from '../crypto/crypto.module';
import { StorageModule } from '../storage/storage.module';
import { WebhookController } from './webhook.controller';
import { WebhookEventsController } from './webhook-events.controller';
import { WebhookService, WEBHOOK_QUEUE } from './webhook.service';
import { WebhookEventsService } from './webhook-events.service';
import { WebhookProcessor } from './webhook.processor';
import { AUTOMATION_QUEUE } from '../automations/automations.queue';

@Module({
  imports: [
    PrismaModule,
    EventsModule,
    CryptoModule,
    StorageModule,
    BullModule.registerQueue({
      name: WEBHOOK_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 1000,
      },
    }),
    // Solo para ENCOLAR runs del orquestador (v3 feature 18). Registrar la cola no importa
    // su módulo: este worker no ejecuta ni un nodo, lo hace el worker del orquestador.
    BullModule.registerQueue({
      name: AUTOMATION_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 1000,
      },
    }),
  ],
  controllers: [WebhookController, WebhookEventsController],
  providers: [WebhookService, WebhookEventsService, WebhookProcessor],
})
export class WebhookModule {}
