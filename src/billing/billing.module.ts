import { Module, OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PgBossService } from '../queue/pgboss.service';
import { STANDARD_RETRY } from '../queue/queue-options';
import { BillingController } from './billing.controller';
import { BillingService, BILLING_QUEUE } from './billing.service';
import { BillingProcessor } from './billing.processor';

@Module({
  imports: [PrismaModule],
  controllers: [BillingController],
  providers: [BillingService, BillingProcessor],
  exports: [BillingService],
})
export class BillingModule implements OnModuleInit {
  constructor(private readonly queue: PgBossService) {}

  async onModuleInit() {
    await this.queue.createQueue(BILLING_QUEUE, STANDARD_RETRY);
  }
}
