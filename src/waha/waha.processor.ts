import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from 'pg-boss';
import { PgBossService } from '../queue/pgboss.service';
import { STANDARD_RETRY } from '../queue/queue-options';
import { WahaService, WAHA_QUEUE, WAHA_HISTORY_QUEUE } from './waha.service';

// Worker de la reconciliación de sesiones WAHA y de la importación de historial. Antes
// vivían en la misma cola de BullMQ, distinguidos por `job.name`; en pg-boss el nombre del
// job ES el nombre de la cola, así que son dos colas — misma idea, sin necesitar un `switch`.
@Injectable()
export class WahaProcessor implements OnModuleInit {
  private readonly logger = new Logger(WahaProcessor.name);

  constructor(
    private readonly waha: WahaService,
    private readonly queue: PgBossService,
  ) {}

  async onModuleInit() {
    await this.queue.createQueue(WAHA_QUEUE, STANDARD_RETRY);
    await this.queue.createQueue(WAHA_HISTORY_QUEUE, STANDARD_RETRY);
    await this.queue.work(WAHA_QUEUE, () => this.reconcileTick());
    await this.queue.work<{ tenantId: string; conversationId: string }>(WAHA_HISTORY_QUEUE, (job) =>
      this.waha.importHistory(job.data.tenantId, job.data.conversationId),
    );
  }

  private async reconcileTick() {
    const s = await this.waha.reconcile();
    // Solo se loguea cuando hubo algo que corregir: si no, son 720 líneas al día.
    if (s.updated || s.restarted || s.deleted) {
      this.logger.log(
        `Reconciliación: ${s.checked} revisadas, ${s.updated} actualizadas, ` +
          `${s.restarted} reiniciadas, ${s.deleted} borradas.`,
      );
    }
    // La purga va aquí y no en su propio job: es barata y comparte cadencia.
    // Un fallo suyo no debe marcar fallida la reconciliación.
    const purged = await this.waha
      .purgeWebhookEvents()
      .catch((e: Error) => {
        this.logger.warn(`No se pudo purgar WebhookEvent: ${e.message}`);
        return 0;
      });
    if (purged) this.logger.log(`WebhookEvent purgados: ${purged}.`);
    return { ...s, purged };
  }
}
