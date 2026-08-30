import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Job } from 'pg-boss';
import { PgBossService } from '../queue/pgboss.service';
import { STANDARD_RETRY } from '../queue/queue-options';
import { BillingService, BILLING_QUEUE } from './billing.service';

// Worker de la cola de eventos de facturación. Reintentos/backoff los configura
// el módulo. El trabajo real (actualizar estado de suscripción) va aquí, nunca
// inline en el webhook.
@Injectable()
export class BillingProcessor implements OnModuleInit {
  constructor(
    private readonly billing: BillingService,
    private readonly queue: PgBossService,
  ) {}

  async onModuleInit() {
    await this.queue.createQueue(BILLING_QUEUE, STANDARD_RETRY);
    await this.queue.work<{ event: any }>(BILLING_QUEUE, (job) => this.process(job));
  }

  async process(job: Job<{ event: any }>) {
    await this.billing.applyEvent(job.data.event);
  }
}
