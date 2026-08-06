import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { deleteSession, listSessions, restartSession, updateSessionWebhook } from './waha.client';
import {
  decideForConnection,
  orphanSessions,
  webhookNeedsUpdate,
  MISSING,
  ReconcileAction,
} from './waha.reconcile';
import { wahaHmacKey, WAHA_EVENTS_VERSION } from '../webhook/waha';
import { PLATFORM_TENANT_ID } from '../platform/platform.constants';

export const WAHA_QUEUE = 'waha-reconcile';

// Cada cuánto se reconcilia. Def. 2 min: suficiente para que una caída no pase
// desapercibida sin castigar a la instancia con listados constantes.
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;

// Retención de WebhookEvent procesados con éxito.
const DEFAULT_EVENT_RETENTION_DAYS = 14;

@Injectable()
export class WahaService implements OnModuleInit {
  private readonly logger = new Logger(WahaService.name);
  private readonly wahaUrl: string;
  private readonly intervalMs: number;
  private readonly eventRetentionDays: number;
  private readonly callbackUrl: string;
  private readonly webhookSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    @InjectQueue(WAHA_QUEUE) private readonly queue: Queue,
    config: ConfigService,
  ) {
    this.wahaUrl = (config.get<string>('WAHA_URL') ?? '').replace(/\/$/, '');
    this.intervalMs =
      Number(config.get<string>('WAHA_RECONCILE_MS')) || DEFAULT_INTERVAL_MS;
    // 0 o negativo desactiva la purga.
    const days = config.get<string>('WEBHOOKEVENT_RETENTION_DAYS');
    this.eventRetentionDays = days === undefined ? DEFAULT_EVENT_RETENTION_DAYS : Number(days);
    this.callbackUrl = config.get<string>('WAHA_CALLBACK_URL') ?? '';
    this.webhookSecret = config.get<string>('WAHA_WEBHOOK_SECRET') ?? '';
  }

  // Job repeatable de BullMQ, NO setInterval: `onModuleInit` corre en cada réplica,
  // así que un setInterval doble-dispararía con dos instancias del backend. El
  // scheduler vive en Redis y solo encola una vez por periodo.
  async onModuleInit() {
    if (!this.wahaUrl) return; // WAHA no configurado: nada que reconciliar
    try {
      await this.queue.add(
        'reconcile',
        {},
        {
          repeat: { every: this.intervalMs },
          jobId: 'waha-reconcile-tick', // idempotente: no acumula schedulers al reiniciar
          removeOnComplete: 10,
        },
      );
    } catch (e) {
      this.logger.warn(`No se pudo programar la reconciliación: ${(e as Error).message}`);
    }
  }

  // Purga de eventos ya procesados. Nada los limpiaba, y con `message.any` (un
  // evento por cada envío propio), las mutaciones y el tráfico de grupos el
  // volumen se multiplica — `rawPayload` es Json, no son filas baratas.
  // Los `failed` se conservan: son justo los que hay que poder inspeccionar y
  // reproducir desde /auditoria.
  async purgeWebhookEvents(): Promise<number> {
    if (this.eventRetentionDays <= 0) return 0;
    const cutoff = new Date(Date.now() - this.eventRetentionDays * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.webhookEvent.deleteMany({
      where: { processStatus: 'ok', createdAt: { lt: cutoff } },
    });
    return count;
  }

  // Compara la DB contra el estado real de la instancia y corrige la deriva.
  // Devuelve un resumen para el log/las métricas.
  async reconcile(): Promise<{
    checked: number;
    updated: number;
    restarted: number;
    deleted: number;
    resubscribed: number;
  }> {
    const conns = await this.prisma.wabaConnection.findMany({
      where: { platform: 'waha' },
      include: { tenant: { select: { status: true } } },
    });
    const summary = {
      checked: conns.length,
      updated: 0,
      restarted: 0,
      deleted: 0,
      resubscribed: 0,
    };
    if (!conns.length) return summary;

    // Se agrupan por instancia: la gestionada (baseUrl null) y las BYO. Así se
    // lista una vez por instancia en vez de una por conexión.
    const byInstance = new Map<string, typeof conns>();
    for (const c of conns) {
      const key = c.baseUrl ?? this.wahaUrl;
      if (!key) continue;
      const list = byInstance.get(key) ?? [];
      list.push(c);
      byInstance.set(key, list);
    }

    for (const [baseUrl, group] of byInstance) {
      // La api key va cifrada por fila; todas las de una instancia comparten la misma.
      const apiKey = this.crypto.decrypt(group[0].accessTokenEnc);
      let remote;
      try {
        remote = await listSessions(baseUrl, apiKey);
      } catch (e) {
        // Instancia caída: no tocamos nada. Marcar todo como MISSING sería peor
        // que dejarlo quieto (un blip de red no es una sesión perdida).
        this.logger.warn(`Reconciliación omitida para una instancia: ${(e as Error).message}`);
        continue;
      }
      const remoteByName = new Map(remote.map((s) => [s.name, s.status]));

      for (const conn of group) {
        const remoteStatus = remoteByName.get(conn.phoneNumberId) ?? null;
        const action = decideForConnection(
          { status: conn.status, tenantSuspended: conn.tenant.status === 'suspended' },
          remoteStatus,
        );
        // Un fallo en una conexión no aborta el resto. Los fallos de worker no
        // llegan al ErrorLog global (es un filtro HTTP), así que se registran aquí
        // y el conteo de la cola los delata en Grafana.
        try {
          await this.applyAction(conn, baseUrl, apiKey, action, summary);
        } catch (e) {
          this.logger.warn(
            `Reconciliación falló para ${conn.phoneNumberId}: ${(e as Error).message}`,
          );
        }
        // La re-suscripción va FUERA del switch de acciones: el caso abrumadoramente
        // común es `none` (estado coherente), y ahí también hay que re-suscribir.
        if (action.kind !== 'delete') {
          try {
            await this.resubscribe(conn, baseUrl, apiKey, remoteStatus, summary);
          } catch (e) {
            this.logger.warn(
              `No se pudo re-suscribir ${conn.phoneNumberId}: ${(e as Error).message}`,
            );
          }
        }
      }

      // Huérfanas: existen en la instancia pero ya no tienen fila.
      for (const name of orphanSessions(
        remote.map((s) => s.name),
        group.map((c) => c.phoneNumberId),
      )) {
        try {
          await deleteSession(baseUrl, apiKey, name);
          summary.deleted++;
          this.logger.log(`Sesión huérfana ${name} borrada.`);
        } catch (e) {
          this.logger.warn(`No se pudo borrar la huérfana ${name}: ${(e as Error).message}`);
        }
      }
    }
    return summary;
  }

  private async applyAction(
    conn: { id: string; phoneNumberId: string },
    baseUrl: string,
    apiKey: string,
    action: ReconcileAction,
    summary: { updated: number; restarted: number; deleted: number },
  ) {
    if (action.kind === 'none') return;

    if (action.kind === 'delete') {
      await deleteSession(baseUrl, apiKey, conn.phoneNumberId);
      await this.setStatus(conn.id, MISSING);
      summary.deleted++;
      this.logger.log(`Sesión ${conn.phoneNumberId} borrada (${action.reason}).`);
      return;
    }

    if (action.kind === 'restart') {
      await restartSession(baseUrl, apiKey, conn.phoneNumberId);
      await this.setStatus(conn.id, action.status);
      summary.restarted++;
      this.logger.warn(`Sesión ${conn.phoneNumberId} en ${action.status}: reiniciada.`);
      return;
    }

    await this.setStatus(conn.id, action.status);
    summary.updated++;
  }

  // Re-suscribe los eventos de una sesión emparejada antes de que existiera la
  // lista actual. Se hace UNA vez por versión: el PUT reinicia la sesión.
  private async resubscribe(
    conn: { id: string; tenantId: string; phoneNumberId: string; webhookVersion: number },
    baseUrl: string,
    apiKey: string,
    remoteStatus: string | null,
    summary: { resubscribed: number },
  ) {
    if (!webhookNeedsUpdate(conn.webhookVersion, WAHA_EVENTS_VERSION, remoteStatus)) return;
    // El tenant de plataforma no debería tener canales; no se toca.
    if (conn.tenantId === PLATFORM_TENANT_ID) return;
    // Sin secreto no hay firma válida: re-suscribir dejaría todo webhook posterior
    // en 401 y el inbound se perdería en silencio. Mejor no tocar nada.
    if (!this.callbackUrl || !this.webhookSecret) {
      this.logger.warn(
        'Re-suscripción omitida: falta WAHA_CALLBACK_URL o WAHA_WEBHOOK_SECRET.',
      );
      return;
    }
    await updateSessionWebhook(
      baseUrl,
      apiKey,
      conn.phoneNumberId,
      this.callbackUrl,
      wahaHmacKey(this.webhookSecret, conn.phoneNumberId),
    );
    await this.prisma.wabaConnection.update({
      where: { id: conn.id },
      data: { webhookVersion: WAHA_EVENTS_VERSION },
    });
    summary.resubscribed++;
    this.logger.log(
      `Sesión ${conn.phoneNumberId} re-suscrita a la versión ${WAHA_EVENTS_VERSION} de eventos.`,
    );
  }

  private setStatus(id: string, status: string) {
    return this.prisma.wabaConnection.update({ where: { id }, data: { status } });
  }
}
