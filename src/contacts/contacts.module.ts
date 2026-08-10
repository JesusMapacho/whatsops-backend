import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ContactListsService } from './contact-lists.service';
import { ContactListsController } from './contact-lists.controller';

// Carteras de clientes. Se exporta el servicio porque el masivo y los estados sacan de
// aquí sus destinatarios — con el acceso por rol ya comprobado, no re-implementado.
@Module({
  imports: [PrismaModule],
  controllers: [ContactListsController],
  providers: [ContactListsService],
  exports: [ContactListsService],
})
export class ContactsModule {}
