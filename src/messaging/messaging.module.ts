import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../crypto/crypto.module';
import { EventsModule } from '../events/events.module';
import { StorageModule } from '../storage/storage.module';
import { WahaModule } from '../waha/waha.module';
import { ContactsModule } from '../contacts/contacts.module';
import { MessagingService } from './messaging.service';
import { ConversationsService } from './conversations.service';
import { CannedResponsesService } from './canned-responses.service';
import { BroadcastService } from './broadcast.service';
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
    // El masivo y los estados sacan sus destinatarios de las carteras, con el acceso por
    // rol ya comprobado en su servicio en vez de re-implementado aquí.
    ContactsModule,
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
  // MessagingService sale desde el v3: los nodos `message.send` y `templates.sync` del
  // orquestador lo ENVUELVEN, para que la ventana de 24 h y los topes se apliquen una sola
  // vez y en un solo sitio.
  exports: [ConversationsService, MessagingService],
})
export class MessagingModule {}
