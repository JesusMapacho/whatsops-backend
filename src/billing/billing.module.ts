import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BillingController } from './billing.controller';
import { BillingService, BILLING_QUEUE } from './billing.service';
import { BillingProcessor } from './billing.processor';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({
      name: BILLING_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 1000,
      },
    }),
  ],
  controllers: [BillingController],
  providers: [BillingService, BillingProcessor],
  exports: [BillingService],
})
export class BillingModule {}
