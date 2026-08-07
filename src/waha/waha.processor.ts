import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { WahaService, WAHA_QUEUE } from './waha.service';

// Worker de la reconciliación de sesiones WAHA. Reintentos/backoff los configura
// el módulo. El disparo es un job repeatable programado en WahaService.onModuleInit.
@Processor(WAHA_QUEUE)
export class WahaProcessor extends WorkerHost {
  private readonly logger = new Logger(WahaProcessor.name);

  constructor(private readonly waha: WahaService) {
    super();
  }

  async process(job: { name: string; data: any }) {
    // Dos tipos de job en la misma cola: el tick de reconciliación (repeatable) y
    // la importación de historial de una conversación (a demanda).
    if (job.name === 'history') {
      return this.waha.importHistory(job.data.tenantId, job.data.conversationId);
    }

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
