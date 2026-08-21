import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { WEBHOOK_QUEUE } from '../webhook/webhook.service';
import { BILLING_QUEUE } from '../billing/billing.service';
import { WAHA_QUEUE } from '../waha/waha.service';
import { PrismaService } from '../prisma/prisma.service';
import { estadoWaha } from '../waha/waha.client';

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
  private readonly wahaSessions: Gauge<string>;
  private readonly wahaUp: Gauge<string>;
  private readonly wahaUrl: string;
  private readonly wahaKey: string;

  constructor(
    @InjectQueue(WEBHOOK_QUEUE) private readonly webhookQueue: Queue,
    @InjectQueue(BILLING_QUEUE) private readonly billingQueue: Queue,
    @InjectQueue(WAHA_QUEUE) private readonly wahaQueue: Queue,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.wahaUrl = (config.get<string>('WAHA_URL') ?? '').replace(/\/$/, '');
    this.wahaKey = config.get<string>('WAHA_API_KEY') ?? '';

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

    // Solo `status`: sin label de tenant, por la doctrina de cardinalidad de
    // arriba. Es la señal de operación de la capa gratuita — si baja el número de
    // WORKING, hay tenants que dejaron de recibir.
    this.wahaSessions = new Gauge({
      name: 'waha_sessions',
      help: 'Sesiones WAHA por estado',
      labelNames: ['status'],
      registers: [this.registry],
    });

    // ¿Responde la instancia de WAHA? 1 = sí, 0 = no, ausente = no configurada.
    //
    // Existe porque `waha_sessions` NO sirve para esto y es una trampa: se deriva de
    // `WabaConnection`, y con el contenedor caído la reconciliación no toca nada a
    // propósito («un blip de red no es una sesión perdida», waha.service.ts). Las filas se
    // quedan congeladas en WORKING, así que el gauge sigue reportando sesiones sanas, la UI
    // dice «conectado» y Grafana lo confirma mientras nadie recibe un solo mensaje.
    //
    // Cualquier alerta colgada del otro gauge hereda esa mentira. Esta se mide contra la
    // instancia de verdad, en cada scrape.
    this.wahaUp = new Gauge({
      name: 'waha_up',
      help: 'La instancia WAHA responde (1) o no (0)',
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
      [WAHA_QUEUE, this.wahaQueue],
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

    // Alcanzabilidad real de la instancia. Se pregunta en cada scrape (cada 15 s) porque
    // es un `GET /api/sessions` a loopback: más barato que el error de creer que todo está
    // bien durante media hora.
    const estado = await estadoWaha(this.wahaUrl, this.wahaKey);
    if (estado === 'disabled') this.wahaUp.reset();
    else this.wahaUp.set(estado === 'up' ? 1 : 0);

    // Sesiones WAHA por estado. El estado lo mantiene al día la reconciliación
    // (waha.service), así que aquí basta con contar filas. OJO: esto refleja la DB, no la
    // instancia — para saber si WAHA responde está `waha_up`.
    try {
      const rows = await this.prisma.wabaConnection.groupBy({
        by: ['status'],
        where: { platform: 'waha' },
        _count: { _all: true },
      });
      this.wahaSessions.reset(); // un estado que desaparece debe dejar de reportarse
      for (const r of rows) {
        this.wahaSessions.set({ status: r.status }, r._count._all);
      }
    } catch {
      // si la DB no responde, no rompemos el scrape del resto de métricas
    }

    return this.registry.metrics();
  }
}
