import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

// AuthModule por AuthService.sign(): aceptar una invitación deja sesión iniciada,
// y la forma de esa sesión se decide en un solo sitio.
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [InvitationsController],
  providers: [InvitationsService],
})
export class InvitationsModule {}
