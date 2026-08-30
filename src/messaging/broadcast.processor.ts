import { Injectable, OnModuleInit } from '@nestjs/common';
import { PgBossService } from '../queue/pgboss.service';
import { NO_RETRY } from '../queue/queue-options';
import { BroadcastService, BROADCAST_QUEUE } from './broadcast.service';

// Worker del envío masivo. Un job RETRASADO por destinatario (el ritmo lo pone el
// `startAfter` de cada uno, no un sleep aquí dentro).
//
// `retryLimit: 0`: reintentar un envío en frío es lo peor que se puede
// hacer. El POST pudo llegar y perderse la respuesta, y escribirle DOS VECES a un
// desconocido es literalmente lo que hace que te marquen como spam.
@Injectable()
export class BroadcastProcessor implements OnModuleInit {
  constructor(
    private readonly broadcast: BroadcastService,
    private readonly queue: PgBossService,
  ) {}

  async onModuleInit() {
    await this.queue.createQueue(BROADCAST_QUEUE, NO_RETRY);
    await this.queue.work<{ recipientId: string }>(BROADCAST_QUEUE, (job) =>
      this.broadcast.processRecipient(job.data.recipientId),
    );
  }
}
