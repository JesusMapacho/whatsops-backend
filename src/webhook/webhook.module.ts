import { Module, OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../events/events.module';
import { CryptoModule } from '../crypto/crypto.module';
import { StorageModule } from '../storage/storage.module';
import { PgBossService } from '../queue/pgboss.service';
import { STANDARD_RETRY } from '../queue/queue-options';
import { WebhookController } from './webhook.controller';
import { WebhookEventsController } from './webhook-events.controller';
import { WebhookService, WEBHOOK_QUEUE } from './webhook.service';
import { WebhookEventsService } from './webhook-events.service';
import { WebhookProcessor } from './webhook.processor';

@Module({
  imports: [PrismaModule, EventsModule, CryptoModule, StorageModule],
  controllers: [WebhookController, WebhookEventsController],
  providers: [WebhookService, WebhookEventsService, WebhookProcessor],
})
export class WebhookModule implements OnModuleInit {
  constructor(private readonly queue: PgBossService) {}

  async onModuleInit() {
    await this.queue.createQueue(WEBHOOK_QUEUE, STANDARD_RETRY);
  }
}
