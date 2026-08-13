import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { StorageService } from '../storage/storage.service';
import { withMediaUrl } from './media.util';
import {
  buildConversationWhere,
  conversationScopeWhere,
  INBOX_TAKE,
  LAST_MESSAGE_SELECT,
  parseStatus,
  shapeConversationRow,
} from './conversations.util';
import { MessagingService } from './messaging.service';

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly storage: StorageService,
    private readonly messaging: MessagingService,
  ) {}

  // Marca la conversación como leída y avisa al cliente (palomitas azules).
  //
  // Se llama al abrir el hilo, al responder y al llegar un mensaje con el hilo
  // abierto. Antes solo pasaba al abrir, así que con la conversación abierta los
  // no-leídos se seguían acumulando y el cliente nunca veía las palomitas.
  //
  // Emite `conversation:updated` para que la lista de otras pestañas/agentes
  // refresque su contador en vez de esperar a un refetch.
  async markRead(tenantId: string, id: string) {
    // SQL crudo a propósito: leer NO es actividad de la conversación. Con
    // `updateMany`, el `@updatedAt` del modelo tocaría `updatedAt`, y como la
    // bandeja ordena por ese campo, abrir un hilo lo catapultaba al principio de
    // la lista y reordenaba todo bajo el cursor solo por mirarlo.
    //
    // El `AT TIME ZONE 'UTC'` NO es adorno. Las columnas son TIMESTAMP **sin zona** y
    // Prisma guarda ahí siempre hora UTC. Cualquier valor con zona (`NOW()`, o un
    // `Date` pasado como parámetro, que viaja como timestamptz) lo convierte Postgres
    // usando la zona de la SESIÓN al meterlo en la columna: con la base en
    // America/Mexico_City el `lastReadAt` se guardaba 6 h por detrás y los mensajes
    // recientes seguían contando como no leídos para siempre.
    //
    // Verificado contra la base: sin esto queda 17:16 donde el resto del sistema
    // escribe 23:16.
    const count = await this.prisma.$executeRaw`
      UPDATE "Conversation" SET "lastReadAt" = NOW() AT TIME ZONE 'UTC'
      WHERE id = ${id} AND "tenantId" = ${tenantId}`;
    if (!count) return { read: false };

    // Mejor esfuerzo, con catch OBLIGATORIO: una promesa rechazada sin manejar
    // tumba el proceso de Node, y el fetch a un WAHA caído rechaza.
    this.messaging
      .markSeen(tenantId, id)
      .catch((e: Error) => this.logger.warn(`No se pudo marcar como leído: ${e.message}`));

    this.events.emitToTenant(tenantId, 'conversation:updated', { id, unread: 0 });
    return { read: true };
  }

  async list(
    tenantId: string,
    filter: string | undefined,
    userId: string,
    role: string,
    q?: string,
    assignedUserId?: string,
  ) {
    const convs = await this.prisma.conversation.findMany({
      where: buildConversationWhere(tenantId, filter, userId, role, q, assignedUserId),
      include: {
        contact: true,
        assignedUser: { select: { id: true, email: true } },
        // La última línea de cada hilo, para la previsualización de la bandeja. Va
        // como relación anidada y no como query aparte: Prisma la resuelve con la
        // misma llamada. Se manda el mensaje crudo, no un texto ya renderizado, para
        // que el cliente lo pinte con las mismas reglas que usa en el hilo.
        messages: { orderBy: { createdAt: 'desc' }, take: 1, select: LAST_MESSAGE_SELECT },
      },
      orderBy: { updatedAt: 'desc' },
      take: INBOX_TAKE,
    });

    // Conteo de no leídos en UNA query: el corte (lastReadAt) es por conversación,
    // así que un groupBy no basta; se correlaciona con Conversation en SQL crudo.
    const ids = convs.map((c) => c.id);
    const rows = ids.length
      ? await this.prisma.$queryRaw<{ conversationId: string; unread: number }[]>`
          SELECT m."conversationId", COUNT(*)::int AS unread
          FROM "Message" m
          JOIN "Conversation" c ON c.id = m."conversationId"
          WHERE m."tenantId" = ${tenantId}
            AND m.direction = 'in'::"MessageDirection"
            AND (c."lastReadAt" IS NULL OR m."createdAt" > c."lastReadAt")
            AND m."conversationId" IN (${Prisma.join(ids)})
          GROUP BY m."conversationId"`
      : [];
    const unread = new Map(rows.map((r) => [r.conversationId, Number(r.unread)]));

    return convs.map((c) =>
      shapeConversationRow(c, unread.get(c.id) ?? 0, (k) => this.storage.signedUrl(k)),
    );
  }

  // Lanza si la conversación no existe o el agente no puede acceder (no es suya ni abierta).
  async assertAccess(tenantId: string, id: string, userId: string, role: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: conversationScopeWhere(tenantId, id, userId, role),
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada');
    return conv;
  }

  async history(tenantId: string, id: string, userId: string, role: string, limit = 50, before?: string) {
    await this.assertAccess(tenantId, id, userId, role);

    // Trae las últimas `limit` (o anteriores a `before`), devueltas en orden ascendente.
    const page = await this.prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
      ...(before ? { cursor: { id: before }, skip: 1 } : {}),
    });

    // Abrir la conversación = marcarla leída. Solo en la PRIMERA página: este mismo
    // método pagina hacia atrás con `before`, y ahí no aplica.
    if (!before) await this.markRead(tenantId, id);

    // Adjunta una mediaUrl firmada y temporal a los mensajes con adjunto.
    return page.reverse().map((m) => withMediaUrl(m, (k) => this.storage.signedUrl(k)));
  }

  async assign(tenantId: string, id: string, targetUserId: string | undefined, currentUserId: string, role: string) {
    await this.assertAccess(tenantId, id, currentUserId, role);
    const assignedUserId = targetUserId ?? currentUserId;
    const user = await this.prisma.user.findFirst({
      where: { id: assignedUserId, tenantId },
    });
    if (!user) throw new BadRequestException('El agente no pertenece a este tenant');

    const { count } = await this.prisma.conversation.updateMany({
      where: { id, tenantId },
      data: { assignedUserId },
    });
    if (!count) throw new NotFoundException('Conversación no encontrada');

    this.events.emitToTenant(tenantId, 'conversation:updated', { id, assignedUserId });
    return { id, assignedUserId };
  }

  async setStatus(tenantId: string, id: string, statusInput: unknown, userId: string, role: string) {
    await this.assertAccess(tenantId, id, userId, role);
    let status;
    try {
      status = parseStatus(statusInput);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const { count } = await this.prisma.conversation.updateMany({
      where: { id, tenantId },
      data: { status },
    });
    if (!count) throw new NotFoundException('Conversación no encontrada');

    this.events.emitToTenant(tenantId, 'conversation:updated', { id, status });
    return { id, status };
  }

  // Las notas del hilo viven en `Activity` desde el v8 (feature 34): el modelo `Note`
  // se absorbió ahí para que una nota escrita en la bandeja también aparezca en el
  // timeline de la ficha del cliente. Estos dos métodos mantienen el CONTRATO de
  // `GET/POST /conversations/:id/notes` intacto, así que la bandeja no cambia.
  //
  // El filtro por `type: 'note'` no es cosmético: `Activity` también recoge cambios de
  // etapa y cierres de trato, y sin él el panel de notas del hilo se llenaría de eventos
  // del CRM.
  async listNotes(tenantId: string, id: string, userId: string, role: string) {
    await this.assertAccess(tenantId, id, userId, role);
    return this.prisma.activity.findMany({
      where: { conversationId: id, tenantId, type: 'note' },
      include: { author: { select: { id: true, email: true } } },
      // Por `occurredAt` y no `createdAt`: son iguales para una nota, pero el timeline
      // ordena por cuándo pasó y las dos vistas tienen que contar lo mismo.
      orderBy: { occurredAt: 'asc' },
    });
  }

  async addNote(tenantId: string, id: string, authorId: string, role: string, body: unknown) {
    // Devuelve la conversación, así que el `contactId` que `Activity` exige sale de aquí
    // sin una segunda query.
    const conv = await this.assertAccess(tenantId, id, authorId, role);
    if (typeof body !== 'string' || !body.trim()) {
      throw new BadRequestException('Campo requerido: body');
    }
    return this.prisma.activity.create({
      data: {
        tenantId,
        type: 'note',
        contactId: conv.contactId,
        conversationId: id,
        authorId,
        body: body.trim(),
      },
      include: { author: { select: { id: true, email: true } } },
    });
  }
}
