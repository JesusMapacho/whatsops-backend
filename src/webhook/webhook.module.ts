import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../events/events.module';
import { WebhookController } from './webhook.controller';
import { WebhookEventsController } from './webhook-events.controller';
import { WebhookService, WEBHOOK_QUEUE } from './webhook.service';
import { WebhookEventsService } from './webhook-events.service';
import { WebhookProcessor } from './webhook.processor';

@Module({
  imports: [
    PrismaModule,
    EventsModule,
    BullModule.registerQueue({
      name: WEBHOOK_QUEUE,
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
