import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { VerificationService } from './verification.service';
import { CODE_SENDER, StubCodeSender } from './code-sender';

@Module({
  imports: [PrismaModule],
  providers: [
    VerificationService,
    // ponytail: sender stub; enlazar el real (SES/Twilio/Cloud API) aquí.
    { provide: CODE_SENDER, useClass: StubCodeSender },
  ],
  exports: [VerificationService],
})
export class VerificationModule {}
