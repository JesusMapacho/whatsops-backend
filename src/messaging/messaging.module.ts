import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../crypto/crypto.module';
import { EventsModule } from '../events/events.module';
import { MessagingService } from './messaging.service';
import { ConversationsService } from './conversations.service';
import { CannedResponsesService } from './canned-responses.service';
import { ConversationsController } from './conversations.controller';
import { TemplatesController } from './templates.controller';
import { CannedResponsesController } from './canned-responses.controller';

@Module({
  imports: [PrismaModule, CryptoModule, EventsModule],
  controllers: [ConversationsController, TemplatesController, CannedResponsesController],
  providers: [MessagingService, ConversationsService, CannedResponsesService],
  exports: [ConversationsService],
})
export class MessagingModule {}
