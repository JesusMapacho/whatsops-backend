import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../crypto/crypto.module';
import { EventsModule } from '../events/events.module';
import { StorageModule } from '../storage/storage.module';
import { WahaModule } from '../waha/waha.module';
import { MessagingService } from './messaging.service';
import { ConversationsService } from './conversations.service';
import { CannedResponsesService } from './canned-responses.service';
import { BroadcastService, BROADCAST_QUEUE } from './broadcast.service';
import { BroadcastProcessor } from './broadcast.processor';
import { ConversationsController } from './conversations.controller';
import { TemplatesController } from './templates.controller';
import { CannedResponsesController } from './canned-responses.controller';
import { BroadcastController } from './broadcast.controller';
import { StatusService } from './status.service';
import { StatusController } from './status.controller';

@Module({
  imports: [
    PrismaModule,
    CryptoModule,
    EventsModule,
    StorageModule,
    WahaModule,
    BullModule.registerQueue({
      name: BROADCAST_QUEUE,
      defaultJobOptions: {
        // NO se reintenta. El POST pudo llegar y perderse la respuesta, y escribirle
        // dos veces a un desconocido es justo lo que hace que te marquen como spam.
        attempts: 1,
        removeOnComplete: 1000,
        // Los fallidos se conservan un rato: son la traza de por qué se pausó.
        removeOnFail: 1000,
      },
    }),
  ],
  controllers: [
    ConversationsController,
    TemplatesController,
    CannedResponsesController,
    BroadcastController,
    StatusController,
  ],
  providers: [
    MessagingService,
    ConversationsService,
    CannedResponsesService,
    BroadcastService,
    BroadcastProcessor,
    StatusService,
  ],
  exports: [ConversationsService],
})
export class MessagingModule {}
