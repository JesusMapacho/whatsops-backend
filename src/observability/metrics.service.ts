import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { WEBHOOK_QUEUE } from '../webhook/webhook.service';
import { BILLING_QUEUE } from '../billing/billing.service';

// Instrumentación Prometheus. Etiquetas ACOTADAS (method/route/status/tenant);
// nunca userId/teléfono/ID libres (cardinalidad). El detalle por usuario sale
// del sistema de logs (feature 05) o métricas de negocio (feature 07).
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly httpDuration: Histogram<string>;
  readonly httpTotal: Counter<string>;
  readonly httpErrors: Counter<string>;
  private readonly queueJobs: Gauge<string>;

  constructor(
    @InjectQueue(WEBHOOK_QUEUE) private readonly webhookQueue: Queue,
    @InjectQueue(BILLING_QUEUE) private readonly billingQueue: Queue,
  ) {
    collectDefaultMetrics({ register: this.registry });

    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duración de request HTTP',
      labelNames: ['method', 'route', 'status', 'tenant'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
    this.httpTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total de requests HTTP',
      labelNames: ['method', 'route', 'status', 'tenant'],
      registers: [this.registry],
    });
    this.httpErrors = new Counter({
      name: 'http_request_errors_total',
      help: 'Requests HTTP con status >= 400',
      labelNames: ['method', 'route', 'status', 'tenant'],
      registers: [this.registry],
    });

    this.queueJobs = new Gauge({
      name: 'bullmq_jobs',
      help: 'Jobs de BullMQ por cola y estado',
      labelNames: ['queue', 'state'],
      registers: [this.registry],
    });
  }

  observe(method: string, route: string, status: number, tenant: string, seconds: number) {
    const labels = { method, route, status: String(status), tenant };
    this.httpDuration.observe(labels, seconds);
    this.httpTotal.inc(labels);
    if (status >= 400) this.httpErrors.inc(labels);
  }

  // Se muestrea al scrapear: conteos de jobs procesados/fallidos/en espera por cola.
  // ponytail: latencia de proceso por job requeriría QueueEvents; se añade si se mide.
  async scrape(): Promise<string> {
    for (const [name, q] of [
      [WEBHOOK_QUEUE, this.webhookQueue],
      [BILLING_QUEUE, this.billingQueue],
    ] as const) {
      try {
        const counts = await q.getJobCounts('completed', 'failed', 'active', 'waiting', 'delayed');
        for (const [state, value] of Object.entries(counts)) {
          this.queueJobs.set({ queue: name, state }, Number(value) || 0);
        }
      } catch {
        // si Redis no responde, no rompemos el scrape del resto de métricas
      }
    }
    return this.registry.metrics();
  }
}
