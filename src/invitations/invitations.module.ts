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
  // Lo exporta para PlatformModule: invitar a un compañero de plataforma reusa este mismo
  // flujo (token de un solo uso, 7 días, contraseña que pone la persona) con el tenant de
  // plataforma, en vez de tener un segundo camino de alta que se desincronice.
  exports: [InvitationsService],
})
export class InvitationsModule {}
