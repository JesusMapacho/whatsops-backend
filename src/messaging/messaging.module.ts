import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../crypto/crypto.module';
import { EventsModule } from '../events/events.module';
import { MessagingService } from './messaging.service';
import { ConversationsController } from './conversations.controller';
import { TemplatesController } from './templates.controller';

@Module({
  imports: [PrismaModule, CryptoModule, EventsModule],
  controllers: [ConversationsController, TemplatesController],
  providers: [MessagingService],
})
export class MessagingModule {}
