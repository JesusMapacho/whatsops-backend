import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { MessagingService } from './messaging.service';
import { openConversation, resolveContact } from './contact-resolve';
import { parseRecipients } from './csv';
import { decideRecipient, maxRecipients, MAX_CONSECUTIVE_FAILURES, sendIntervalMs } from './broadcast';

export const BROADCAST_QUEUE = 'broadcast';

@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
    @InjectQueue(BROADCAST_QUEUE) private readonly queue: Queue,
  ) {}

  // Lee el CSV y devuelve lo que se enviaría, SIN crear nada. La UI lo enseña antes
  // de pedir la confirmación: el desastre realista no es un CSV mal formado, es
  // "quería subir 12 números y el archivo tenía 1200".
  preview(csv: string) {
    const parsed = parseRecipients(csv);
    return {
      count: parsed.recipients.length,
      duplicates: parsed.duplicates,
      rejected: parsed.rejected,
      // Muestra corta: la lista entera es PII de gente que todavía no es cliente y
      // no hace falta para decidir.
      sample: parsed.recipients.slice(0, 5).map((r) => r.phone),
    };
  }

  async create(tenantId: string, userId: string, body: any) {
    const conn = await this.messaging.assertColdAllowed(tenantId, body);

    // Un solo envío activo por tenant. Mata de golpe la clase "100 envíos × 5000
    // destinatarios" sin necesidad de contar jobs.
    const activo = await this.prisma.broadcast.count({
      where: { tenantId, status: 'running' },
    });
    if (activo) {
      throw new BadRequestException('Ya tienes un envío en curso. Espera a que termine o cancélalo.');
    }

    const csv = typeof body?.csv === 'string' ? body.csv : '';
    if (!csv.trim()) throw new BadRequestException('Sube el archivo de destinatarios.');
    const { recipients, duplicates } = parseRecipients(csv);
    if (!recipients.length) throw new BadRequestException('No hay ningún número válido en el archivo.');

    const max = maxRecipients(conn.platform);
    if (recipients.length > max) {
      throw new BadRequestException(
        `Máximo ${max} destinatarios por envío en este canal. El archivo trae ${recipients.length}.`,
      );
    }

    // Confirmación con RECUENTO, no un "¿seguro?". El operador teclea cuántos cree
    // que son; si no cuadra, el archivo no es el que pensaba.
    if (body?.confirmCount !== recipients.length) {
      throw new BadRequestException(
        `Confirma el número de destinatarios: son ${recipients.length}` +
          (duplicates ? ` (${duplicates} repetidos se descartaron).` : '.'),
      );
    }

    const type = body?.type === 'template' ? 'template' : 'text';
    if (type === 'text' && conn.platform !== 'waha') {
      // No es una decisión nuestra: Meta devuelve 131047 si mandas texto libre a
      // quien no te ha escrito. La única forma legal de escribir primero es plantilla.
      throw new BadRequestException('En este canal el primer mensaje tiene que ser una plantilla.');
    }
    if (type === 'text' && !String(body?.text ?? '').trim()) {
      throw new BadRequestException('Escribe el mensaje.');
    }
    if (type === 'template') {
      if (!body?.templateName) throw new BadRequestException('Elige una plantilla.');
      // La plantilla se valida contra el CSV AQUÍ, no destinatario a destinatario:
      // una columna de menos es un problema del archivo, y descubrirlo enviando son
      // 500 errores 132xxx en vez de un mensaje accionable.
      const needed = await this.messaging.templateParamCount(
        tenantId,
        String(body.templateName),
        String(body.templateLanguage ?? 'es'),
      );
      const mal = recipients.find((r) => r.vars.length !== needed || r.vars.some((v) => !v));
      if (mal) {
        throw new BadRequestException(
          `La plantilla necesita ${needed} valores por destinatario y la línea ${mal.line} trae ${mal.vars.length}.`,
        );
      }
    }

    const broadcast = await this.prisma.broadcast.create({
      data: {
        tenantId,
        wabaConnectionId: conn.id,
        createdById: userId,
        type,
        text: type === 'text' ? String(body.text).trim() : null,
        templateName: type === 'template' ? String(body.templateName) : null,
        templateLanguage: type === 'template' ? String(body.templateLanguage ?? 'es') : null,
        total: recipients.length,
      },
    });
    await this.prisma.broadcastRecipient.createMany({
      data: recipients.map((r) => ({ broadcastId: broadcast.id, phone: r.phone, vars: r.vars })),
      skipDuplicates: true,
    });

    const rows = await this.prisma.broadcastRecipient.findMany({
      where: { broadcastId: broadcast.id },
      select: { id: true },
    });
    // Un job RETRASADO por destinatario, no un tick que va sacando de la cola: el
    // retraso vive en Redis y sobrevive a un reinicio, `jobId` hace el encolado
    // idempotente (relanzar no puede duplicar) y no hace falta ningún lock entre
    // réplicas.
    const step = sendIntervalMs(conn.platform);
    await this.queue.addBulk(
      rows.map((r, i) => ({
        name: 'recipient',
        data: { recipientId: r.id },
        opts: { jobId: r.id, delay: i * step },
      })),
    );

    this.logger.log(`Envío ${broadcast.id}: ${rows.length} destinatarios cada ${step} ms.`);
    return { id: broadcast.id, total: rows.length, duplicates };
  }

  list(tenantId: string) {
    return this.prisma.broadcast.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  // Detalle con los destinatarios: "quién no lo recibió y por qué" es la única
  // pregunta que se hace después de un envío.
  async detail(tenantId: string, id: string) {
    const b = await this.prisma.broadcast.findFirst({
      where: { id, tenantId },
      include: {
        recipients: { orderBy: { phone: 'asc' }, take: 5000 },
      },
    });
    if (!b) throw new NotFoundException('Envío no encontrado');
    return b;
  }

  async cancel(tenantId: string, id: string) {
    const { count } = await this.prisma.broadcast.updateMany({
      where: { id, tenantId, status: 'running' },
      data: { status: 'canceled', reason: 'Cancelado por el operador.' },
    });
    if (!count) throw new NotFoundException('Envío no encontrado o ya terminado');
    // Los jobs NO se borran de Redis: borrarlos sería una carrera con el worker que
    // ya tiene uno en la mano. El worker relee el estado y no hace nada.
    await this.closePending(id, 'Envío cancelado.');
    return { id, status: 'canceled' };
  }

  // --- Worker ---

  async processRecipient(recipientId: string) {
    const r = await this.prisma.broadcastRecipient.findUnique({
      where: { id: recipientId },
      include: {
        broadcast: {
          include: {
            wabaConnection: true,
            tenant: { select: { status: true } },
          },
        },
      },
    });
    if (!r) return { action: 'skip', reason: 'Destinatario borrado.' };
    const b = r.broadcast;

    // El cupo se mide ANTES de crear contacto y conversación: al revés, un envío
    // abortado por tope dejaría cientos de conversaciones huérfanas en la bandeja.
    const limit = b.status === 'running' ? await this.messaging.coldQuota(b.tenantId) : { allowed: true as const };

    let exists: boolean | null = null;
    let waId = '';
    if (b.status === 'running' && limit?.allowed) {
      const resolved = await this.messaging
        .coldWaIdFor(b.wabaConnection, r.phone)
        .catch(() => null);
      exists = resolved?.exists ?? null;
      waId = resolved?.waId ?? '';
    }

    const decision = decideRecipient({
      broadcastStatus: b.status,
      recipientStatus: r.status,
      tenantSuspended: b.tenant.status === 'suspended',
      consecutiveFailures: b.consecutiveFailures,
      limit,
      numberExists: exists,
    });

    if (decision.action === 'abort') {
      await this.pause(b.id, decision.reason);
      return decision;
    }
    if (decision.action === 'skip') {
      // "Ya procesado" no se re-marca: sobreescribiría el motivo real con uno inútil.
      if (r.status === 'pending') await this.close(r.id, b.id, 'skipped', decision.reason);
      return decision;
    }

    try {
      const contact = await resolveContact(this.prisma, {
        tenantId: b.tenantId,
        platform: b.wabaConnection.platform,
        waId: waId || r.phone,
        phone: r.phone,
      });
      const conv = await openConversation(this.prisma, {
        tenantId: b.tenantId,
        platform: b.wabaConnection.platform,
        contactId: contact.id,
        wabaConnectionId: b.wabaConnectionId,
        inbound: false,
      });
      // El envío va por el camino de siempre: ahí viven la ventana, la resolución de
      // plantilla y los topes. Duplicarlo aquí sería el bug de mañana.
      const msg = await this.messaging.send(b.tenantId, conv.id, this.sendBody(b, r.vars));

      await this.prisma.$transaction([
        this.prisma.broadcastRecipient.update({
          where: { id: r.id },
          data: { status: 'sent', messageId: msg.id, sentAt: new Date() },
        }),
        this.prisma.broadcast.update({
          where: { id: b.id },
          data: { sent: { increment: 1 }, consecutiveFailures: 0 },
        }),
      ]);
      await this.finishIfDone(b.id);
      return { action: 'send', messageId: msg.id };
    } catch (e) {
      const reason = (e as Error).message ?? 'Falló el envío.';
      await this.prisma.$transaction([
        this.prisma.broadcastRecipient.update({
          where: { id: r.id },
          data: { status: 'failed', reason },
        }),
        this.prisma.broadcast.update({
          where: { id: b.id },
          data: { failed: { increment: 1 }, consecutiveFailures: { increment: 1 } },
        }),
      ]);
      // El cortacircuitos se evalúa aquí y no solo en el siguiente destinatario: si
      // este era el último job, nadie más lo miraría y el envío quedaría "running".
      const after = await this.prisma.broadcast.findUnique({
        where: { id: b.id },
        select: { consecutiveFailures: true },
      });
      if ((after?.consecutiveFailures ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
        await this.pause(b.id, `${MAX_CONSECUTIVE_FAILURES} fallos seguidos: envío pausado para revisar.`);
      } else {
        await this.finishIfDone(b.id);
      }
      this.logger.warn(`Envío ${b.id}, destinatario ${r.phone}: ${reason}`);
      return { action: 'failed', reason };
    }
  }

  // Cuerpo del mensaje para este destinatario. Las variables ya vienen resueltas de
  // la subida, así que el worker nunca necesita el CSV.
  private sendBody(b: { type: string; text: string | null; templateName: string | null; templateLanguage: string | null }, vars: unknown) {
    if (b.type === 'text') return { type: 'text', text: b.text };
    return {
      type: 'template',
      name: b.templateName,
      language: b.templateLanguage,
      params: Array.isArray(vars) ? vars.map((v) => String(v)) : [],
    };
  }

  private async pause(id: string, reason: string) {
    // `status: 'running'` en el where: si otro job ya pausó o el operador canceló,
    // este no debe pisar el motivo original.
    const { count } = await this.prisma.broadcast.updateMany({
      where: { id, status: 'running' },
      data: { status: 'paused', reason },
    });
    if (count) {
      this.logger.warn(`Envío ${id} pausado: ${reason}`);
      // Un solo updateMany cierra el resto. Dejarlos pendientes haría que la consola
      // mostrara 480 "pendientes" que no van a salir nunca.
      await this.closePending(id, reason);
    }
  }

  private async closePending(broadcastId: string, reason: string) {
    const { count } = await this.prisma.broadcastRecipient.updateMany({
      where: { broadcastId, status: 'pending' },
      data: { status: 'skipped', reason },
    });
    if (count) {
      await this.prisma.broadcast.update({
        where: { id: broadcastId },
        data: { skipped: { increment: count } },
      });
    }
  }

  private close(recipientId: string, broadcastId: string, status: string, reason: string) {
    return this.prisma.$transaction([
      this.prisma.broadcastRecipient.update({
        where: { id: recipientId },
        data: { status, reason },
      }),
      this.prisma.broadcast.update({
        where: { id: broadcastId },
        data: { skipped: { increment: 1 } },
      }),
    ]);
  }

  private async finishIfDone(id: string) {
    const pending = await this.prisma.broadcastRecipient.count({
      where: { broadcastId: id, status: 'pending' },
    });
    if (pending) return;
    await this.prisma.broadcast.updateMany({
      where: { id, status: 'running' },
      data: { status: 'done' },
    });
  }
}
