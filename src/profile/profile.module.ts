import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { VerificationModule } from '../verification/verification.module';
import { ProfileService } from './profile.service';
import { ProfileController } from './profile.controller';

@Module({
  imports: [PrismaModule, VerificationModule],
  controllers: [ProfileController],
  providers: [ProfileService],
})
export class ProfileModule {}
