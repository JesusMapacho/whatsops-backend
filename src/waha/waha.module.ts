import { Module, OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../crypto/crypto.module';
import { EventsModule } from '../events/events.module';
import { PgBossService } from '../queue/pgboss.service';
import { STANDARD_RETRY } from '../queue/queue-options';
import { WahaService, WAHA_QUEUE, WAHA_HISTORY_QUEUE } from './waha.service';
import { WahaProcessor } from './waha.processor';

@Module({
  imports: [PrismaModule, CryptoModule, EventsModule],
  providers: [WahaService, WahaProcessor],
  exports: [WahaService],
})
export class WahaModule implements OnModuleInit {
  constructor(private readonly queue: PgBossService) {}

  async onModuleInit() {
    await this.queue.createQueue(WAHA_QUEUE, STANDARD_RETRY);
    await this.queue.createQueue(WAHA_HISTORY_QUEUE, STANDARD_RETRY);
  }
}
