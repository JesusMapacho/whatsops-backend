import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MessagingService } from './messaging.service';
import { openConversation, resolveContact } from './contact-resolve';
import { parseRecipients } from './csv';
import { decideRecipient, maxRecipients, MAX_CONSECUTIVE_FAILURES, sendIntervalMs } from './broadcast';
import { canSend, LifecycleConfig, lifecycleFromEnv } from './lifecycle';
import { ContactListsService } from '../contacts/contact-lists.service';
import { Actor } from '../contacts/access';
import { pickSelected } from '../contacts/pick';

export const BROADCAST_QUEUE = 'broadcast';

// Fila de destinatario antes de persistirla. `contactId` presente = viene de una cartera
// y su waId ya es canónico; `reason` presente = queda excluido de salida, con su motivo.
interface BroadcastRow {
  phone: string;
  vars: string[];
  line: number;
  contactId: string | null;
  reason?: string;
}

// Las dos fuentes devuelven la misma forma para que quien llama no tenga que preguntar
// de dónde vinieron los destinatarios.
interface Fuente {
  recipients: BroadcastRow[];
  duplicates: number;
  excluidos: BroadcastRow[];
}


@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);

  private readonly lifecycle: LifecycleConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
    private readonly lists: ContactListsService,
    @InjectQueue(BROADCAST_QUEUE) private readonly queue: Queue,
    config: ConfigService,
  ) {
    this.lifecycle = lifecycleFromEnv((k) => config.get<string>(k));
  }

  // Devuelve lo que se enviaría, SIN crear nada. La UI lo enseña antes de pedir la
  // confirmación: el desastre realista no es un archivo mal formado, es "quería subir 12
  // números y el archivo tenía 1200".
  //
  // Sirve para las DOS fuentes, y en el camino de cartera no es un lujo: el servidor
  // descuenta a quien no se le puede escribir ahora, así que el recuento que el operador
  // tiene que confirmar solo lo sabe el servidor. Sin esto, confirmar sería imposible.
  async preview(tenantId: string, actor: Actor, body: any) {
    const listId = typeof body?.contactListId === 'string' ? body.contactListId : '';
    if (listId) {
      // Se pasa el body entero para que la previsualización respete la SELECCIÓN: sin
      // eso mostraría el recuento de la cartera completa y volvería a haber dos números
      // distintos en pantalla, que es lo que hacía parecer que estaba mal.
      const { recipients, excluidos } = await this.fromList(tenantId, actor, listId, body);
      return {
        count: recipients.length,
        duplicates: 0,
        // Los excluidos se enseñan con su motivo: "de 40 clientes, 12 no han contestado
        // todavía" es información que cambia la decisión de enviar.
        rejected: excluidos.slice(0, 20).map((r) => ({ line: 0, raw: r.phone, reason: r.reason ?? '' })),
        excluded: excluidos.length,
        sample: recipients.slice(0, 5).map((r) => r.phone),
      };
    }
    const parsed = parseRecipients(typeof body?.csv === 'string' ? body.csv : '');
    return {
      count: parsed.recipients.length,
      duplicates: parsed.duplicates,
      rejected: parsed.rejected,
      excluded: 0,
      // Muestra corta: la lista entera es PII de gente que todavía no es cliente y
      // no hace falta para decidir.
      sample: parsed.recipients.slice(0, 5).map((r) => r.phone),
    };
  }

  async create(tenantId: string, userId: string, actor: Actor, body: any) {
    const conn = await this.messaging.assertColdAllowed(tenantId, body);

    // Un solo envío activo por tenant. Mata de golpe la clase "100 envíos × 5000
    // destinatarios" sin necesidad de contar jobs.
    const activo = await this.prisma.broadcast.count({
      where: { tenantId, status: 'running' },
    });
    if (activo) {
      throw new BadRequestException('Ya tienes un envío en curso. Espera a que termine o cancélalo.');
    }

    // Dos fuentes de destinatarios, y en el plan gratuito solo una.
    //
    // El CSV es un camino de entrada SIN consentimiento: se pegan 500 números y el único
    // freno es el volumen. Una cartera solo contiene gente que nos escribió, así que en
    // gratis es la única fuente. Quien quiera subir listas usa el transporte oficial,
    // donde Meta pone sus propias reglas.
    const listId = typeof body?.contactListId === 'string' ? body.contactListId : '';
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { plan: true },
    });
    const free = (tenant?.plan ?? 'free') === 'free';
    if (free && !listId) {
      throw new BadRequestException(
        'En el plan gratuito los envíos salen de una cartera de clientes: elige una. ' +
          'Solo puede contener a quien te ha escrito alguna vez.',
      );
    }

    const { recipients, duplicates, excluidos } = listId
      ? await this.fromList(tenantId, actor, listId, body)
      : this.fromCsv(body);
    if (!recipients.length) {
      throw new BadRequestException(
        listId
          ? 'Esa cartera no tiene a nadie a quien se le pueda escribir ahora mismo.'
          : 'No hay ningún número válido en el archivo.',
      );
    }

    const max = maxRecipients(conn.platform);
    if (recipients.length > max) {
      throw new BadRequestException(
        `Máximo ${max} destinatarios por envío en este canal. El archivo trae ${recipients.length}.`,
      );
    }

    // Confirmación con RECUENTO, y SOLO para el CSV. Existe para cazar el desastre
    // realista de un archivo: "quería subir 12 números y tenía 1200".
    //
    // Desde una cartera NO se pide, y no es un descuido: el operador elige personas de
    // una lista que está viendo, así que la clase de error que este freno atrapa
    // desaparece por construcción. Pedirlo además obligaba a teclear un número que el
    // servidor calcula (descuenta a quien está en enfriamiento), o sea distinto del que
    // la pantalla mostraba al lado de la cartera. Eso no era un freno, era una trampa.
    if (!listId && body?.confirmCount !== recipients.length) {
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
      // La plantilla se valida contra los destinatarios AQUÍ, no uno a uno: una columna
      // de menos es un problema del archivo, y descubrirlo enviando son 500 errores
      // 132xxx en vez de un mensaje accionable.
      const needed = await this.messaging.templateParamCount(
        tenantId,
        String(body.templateName),
        String(body.templateLanguage ?? 'es'),
      );
      const mal = recipients.find((r) => r.vars.length !== needed || r.vars.some((v) => !v));
      if (mal) {
        throw new BadRequestException(
          listId
            ? `La plantilla necesita ${needed} valores. Desde una cartera se mandan los MISMOS para todos: escríbelos.`
            : `La plantilla necesita ${needed} valores por destinatario y la línea ${mal.line} trae ${mal.vars.length}.`,
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
        // `total` cuenta los que SE VAN a intentar. Los excluidos de salida se guardan
        // como saltados con su motivo, así que no infla el progreso con gente que nunca
        // iba a recibir nada.
        total: recipients.length,
        skipped: excluidos.length,
      },
    });
    await this.prisma.broadcastRecipient.createMany({
      data: [
        ...recipients.map((r) => ({
          broadcastId: broadcast.id,
          phone: r.phone,
          vars: r.vars,
          contactId: r.contactId,
        })),
        // Los excluidos entran ya cerrados: la pregunta de después es "a quién no le
        // llegó y por qué", y sin esta fila la respuesta sería "no aparece".
        ...excluidos.map((r) => ({
          broadcastId: broadcast.id,
          phone: r.phone,
          vars: r.vars,
          contactId: r.contactId,
          status: 'skipped',
          reason: r.reason,
        })),
      ],
      skipDuplicates: true,
    });

    // Solo los pendientes se encolan: los excluidos ya están cerrados.
    const rows = await this.prisma.broadcastRecipient.findMany({
      where: { broadcastId: broadcast.id, status: 'pending' },
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

  // --- Fuentes de destinatarios ---

  private fromCsv(body: any): Fuente {
    const csv = typeof body?.csv === 'string' ? body.csv : '';
    if (!csv.trim()) throw new BadRequestException('Sube el archivo de destinatarios.');
    const { recipients, duplicates } = parseRecipients(csv);
    return {
      recipients: recipients.map((r) => ({
        phone: r.phone,
        vars: r.vars,
        line: r.line,
        // Sin contacto todavía: el worker lo resolverá, con lo que eso cuesta (una
        // consulta por destinatario para averiguar su chatId canónico).
        contactId: null,
      })),
      duplicates,
      // El CSV no puede excluir por ciclo de vida: sus números todavía no son contactos,
      // así que no hay historial que consultar. El filtro real ocurre en el worker.
      excluidos: [],
    };
  }

  // Destinatarios desde una cartera. La diferencia que importa no es la comodidad: sus
  // `waId` son CANÓNICOS porque vinieron de conversaciones reales, así que no hay nada
  // que resolver ni que fabricar. Es lo que hacía fallar en silencio a los estados con
  // números escritos a mano.
  private async fromList(
    tenantId: string,
    actor: Actor,
    listId: string,
    body: any,
  ): Promise<Fuente> {
    // `usableMembers` comprueba el acceso por rol: si el operador no puede usar la
    // cartera, aquí lanza y no hay envío.
    const todos = await this.lists.usableMembers(tenantId, actor, listId);
    // Selección explícita de personas dentro de la cartera. Los ids se validan contra
    // los miembros: sin eso, `contactIds` sería una forma de escribirle a CUALQUIER
    // contacto del tenant pasando por encima de la regla de la cartera.
    const miembros = pickSelected(todos, body?.contactIds);
    // Desde una cartera las variables de plantilla son las MISMAS para todos: no hay
    // columnas de dónde sacar una por persona. Se escriben una vez.
    const vars: string[] = Array.isArray(body?.params)
      ? body.params.map((v: unknown) => String(v ?? '').trim())
      : [];

    // Se filtra por la etapa del ciclo AQUÍ, en la subida: enviar a 250 contactos
    // agotados crearía 250 jobs y 250 queries para nada. Los que no pasan se guardan
    // igual, con su motivo — "quién no lo recibió y por qué" es la pregunta de después.
    const estados = await this.stagesFor(miembros.map((m) => m.id));
    const recipients: BroadcastRow[] = [];
    const excluidos: BroadcastRow[] = [];
    for (const m of miembros) {
      const fila: BroadcastRow = {
        phone: m.phone ?? m.waId,
        vars,
        line: 0,
        contactId: m.id,
      };
      const motivo = estados.get(m.id);
      if (motivo) excluidos.push({ ...fila, reason: motivo });
      else recipients.push(fila);
    }
    return { recipients, duplicates: 0, excluidos };
  }

  // Motivo por el que NO se le puede escribir ahora, por contacto. Ausente = se puede.
  //
  // Dos queries para toda la cartera, no una por contacto: la etapa se DERIVA de
  // `lastInboundAt` y de los salientes, y las dos cosas se pueden agregar de golpe.
  private async stagesFor(contactIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!contactIds.length) return out;

    const convs = await this.prisma.conversation.findMany({
      where: { contactId: { in: contactIds } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, contactId: true, lastInboundAt: true, initiatedByUs: true },
    });
    // Una conversación por contacto: la más reciente, que es la que manda.
    const porContacto = new Map<string, (typeof convs)[number]>();
    for (const c of convs) if (!porContacto.has(c.contactId)) porContacto.set(c.contactId, c);

    const salientes = await this.prisma.message.groupBy({
      by: ['conversationId'],
      where: { conversationId: { in: [...porContacto.values()].map((c) => c.id) }, direction: 'out' },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    const porConv = new Map(salientes.map((s) => [s.conversationId, s]));

    const now = new Date();
    for (const [contactId, conv] of porContacto) {
      // El ciclo de prospección solo rige lo que abrimos nosotros. A quien nos escribió
      // primero no se le aplica: los topes de volumen ya lo cubren.
      if (!conv.initiatedByUs) continue;
      const agg = porConv.get(conv.id);
      const verdict = canSend(
        {
          lastInboundAt: conv.lastInboundAt,
          outCount: agg?._count._all ?? 0,
          lastOutAt: agg?._max.createdAt ?? null,
          now,
        },
        this.lifecycle,
      );
      if (!verdict.ok) out.set(contactId, verdict.message);
    }
    return out;
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

    // Si el destinatario vino de una CARTERA, su contacto ya existe y su `waId` es
    // canónico (salió de una conversación real). No hay nada que resolver: se ahorra una
    // consulta por destinatario y, más importante, se elimina la única forma de
    // equivocarse — fabricar un chatId que no existe.
    let exists: boolean | null = null;
    let waId = '';
    if (b.status === 'running' && limit?.allowed && !r.contactId) {
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
      // Desde cartera el contacto ya está; solo se resuelve en el camino del CSV.
      const contact = r.contactId
        ? { id: r.contactId }
        : await resolveContact(this.prisma, {
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
