import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { BillingService, BILLING_QUEUE } from './billing.service';

// Worker de la cola de eventos de facturación. Reintentos/backoff los configura
// el módulo. El trabajo real (actualizar estado de suscripción) va aquí, nunca
// inline en el webhook.
@Processor(BILLING_QUEUE)
export class BillingProcessor extends WorkerHost {
  constructor(private readonly billing: BillingService) {
    super();
  }

  async process(job: Job<{ event: any }>) {
    await this.billing.applyEvent(job.data.event);
  }
}
