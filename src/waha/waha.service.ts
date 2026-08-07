import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { EventsGateway } from '../events/events.gateway';
import {
  deleteSession,
  fetchChatMessages,
  listSessions,
  restartSession,
  updateSessionWebhook,
} from './waha.client';
import { toHistoryRow, usableHistory } from './waha.history';
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

// Importación de historial: tamaño de página, pausa entre páginas y tope de páginas.
const HISTORY_PAGE_SIZE = 50;
const HISTORY_PAUSE_MS = 800;
const DEFAULT_HISTORY_PAGES = 4; // 200 mensajes por conversación

@Injectable()
export class WahaService implements OnModuleInit {
  private readonly logger = new Logger(WahaService.name);
  private readonly wahaUrl: string;
  private readonly intervalMs: number;
  private readonly eventRetentionDays: number;
  private readonly callbackUrl: string;
  private readonly webhookSecret: string;
  private readonly historyPages: number;
  readonly fullSync: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly events: EventsGateway,
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
    this.historyPages = Number(config.get<string>('WAHA_HISTORY_PAGES')) || DEFAULT_HISTORY_PAGES;
    // fullSync=true trae ~1 año en vez de ~3 meses, a cambio de bastante más
    // trabajo al arrancar la sesión. Por defecto no.
    this.fullSync = config.get<string>('WAHA_FULL_SYNC') === 'true';
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

  // Encola la importación del historial de UNA conversación. Los datos del job
  // llevan SOLO ids: viven en Redis en claro, así que la api key se re-lee y
  // descifra dentro del worker.
  async queueHistoryImport(tenantId: string, conversationId: string) {
    await this.queue.add('history', { tenantId, conversationId });
    return { queued: true };
  }

  // Trae los mensajes anteriores de una conversación y los persiste.
  //
  // Es por conversación y NO un barrido de todos los chats del teléfono: el listado
  // completo incluye la vida privada del dueño (familia, médico, banco), y volcarla
  // a una bandeja de negocio es un problema de privacidad, no un detalle. Además la
  // app se apoya en que "las conversaciones nacen de un inbound".
  async importHistory(tenantId: string, conversationId: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId, platform: 'waha' },
      include: { contact: true, wabaConnection: { include: { tenant: true } } },
    });
    if (!conv) return { imported: 0 };

    // Se re-verifica AQUÍ y no al encolar: un tenant suspendido entre el encolado y
    // la ejecución seguiría extrayendo su WhatsApp.
    if (conv.wabaConnection.tenant.status === 'suspended') {
      this.logger.warn(`Importación cancelada: tenant ${tenantId} suspendido.`);
      return { imported: 0 };
    }

    const baseUrl = conv.wabaConnection.baseUrl ?? this.wahaUrl;
    const apiKey = this.crypto.decrypt(conv.wabaConnection.accessTokenEnc);
    const session = conv.wabaConnection.phoneNumberId;

    // El más antiguo que ya tenemos marca el corte: solo se importa lo anterior.
    const oldest = await this.prisma.message.findFirst({
      where: { tenantId, conversationId },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });

    let imported = 0;
    let offset = 0;
    for (let page = 0; page < this.historyPages; page++) {
      const raw = await fetchChatMessages(
        baseUrl,
        apiKey,
        session,
        conv.contact.waId,
        HISTORY_PAGE_SIZE,
        offset,
      );
      if (!raw.length) break;
      offset += raw.length;

      const rows = usableHistory(raw.map(toHistoryRow), oldest?.createdAt ?? null);
      for (const r of rows) {
        // Idempotente por (tenant, wamid): repetir la importación no duplica.
        try {
          await this.prisma.message.create({
            data: {
              tenantId,
              conversationId,
              direction: r.direction,
              type: r.type,
              payload: r.payload as any,
              wamid: r.wamid,
              status: r.direction === 'in' ? 'delivered' : 'sent',
              createdAt: r.createdAt,
            },
          });
          imported++;
        } catch (e: any) {
          if (e?.code !== 'P2002') throw e; // ya estaba: seguir
        }
      }
      if (raw.length < HISTORY_PAGE_SIZE) break;
      // Serial y con pausa: la instancia tiene reputación compartida entre tenants,
      // y ráfagas de llamadas se rate-limitean o se marcan.
      await new Promise((r) => setTimeout(r, HISTORY_PAUSE_MS));
    }

    if (offset >= this.historyPages * HISTORY_PAGE_SIZE) {
      // Nada de topes silenciosos: si se truncó, se dice.
      this.logger.log(
        `Historial truncado en ${offset} mensajes para la conversación ${conversationId} ` +
          `(tope de ${this.historyPages} páginas).`,
      );
    }
    // UN solo evento al final, no uno por mensaje: son cientos.
    if (imported) this.events.emitToTenant(tenantId, 'conversation:updated', { id: conversationId });
    this.logger.log(`Historial importado: ${imported} mensajes en ${conversationId}.`);
    return { imported };
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
      const configByName = new Map(remote.map((s) => [s.name, s.config]));

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
            await this.resubscribe(
              conn,
              baseUrl,
              apiKey,
              remoteStatus,
              configByName.get(conn.phoneNumberId),
              summary,
            );
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
    currentConfig: any,
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
      // Se re-envía la config actual tal cual: el PUT la reemplaza entera, y perder
      // el bloque `noweb` cambiaría el store de una sesión ya emparejada.
      currentConfig,
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
