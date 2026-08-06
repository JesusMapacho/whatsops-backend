import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../crypto/crypto.module';
import { WahaService, WAHA_QUEUE } from './waha.service';
import { WahaProcessor } from './waha.processor';

@Module({
  imports: [
    PrismaModule,
    CryptoModule,
    BullModule.registerQueue({
      name: WAHA_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 1000,
      },
    }),
  ],
  providers: [WahaService, WahaProcessor],
  exports: [WahaService],
})
export class WahaModule {}
