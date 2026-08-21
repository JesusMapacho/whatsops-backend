import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { RolesModule } from '../roles/roles.module';
import { CryptoModule } from '../crypto/crypto.module';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { AuthController } from './auth.controller';

@Module({
  imports: [
    PrismaModule,
    RolesModule,
    // El secreto TOTP se guarda cifrado, con el mismo AES-256-GCM que los tokens de canal.
    CryptoModule,
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '1d' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, MfaService],
  // Lo exporta para InvitationsModule: aceptar una invitación termina en sesión
  // iniciada, y esa firma vive aquí y en ningún otro sitio.
  // MfaService lo exporta para PlatformModule: resetear el segundo factor de un compañero
  // es una operación de plataforma, y tiene que quedar auditada por su guard.
  exports: [AuthService, MfaService],
})
export class AuthModule {}
