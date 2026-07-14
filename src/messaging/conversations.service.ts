import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { StorageService } from '../storage/storage.service';
import { withMediaUrl } from './media.util';
import { buildConversationWhere, conversationScopeWhere, parseStatus } from './conversations.util';

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly storage: StorageService,
  ) {}

  async list(tenantId: string, filter: string | undefined, userId: string, role: string) {
    const convs = await this.prisma.conversation.findMany({
      where: buildConversationWhere(tenantId, filter, userId, role),
      include: {
        contact: true,
        assignedUser: { select: { id: true, email: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // ponytail: un count por conversación (N+1). Agrupar con groupBy si la lista crece.
    return Promise.all(
      convs.map(async (c) => ({
        ...c,
        unread: await this.prisma.message.count({
          where: {
            conversationId: c.id,
            direction: 'in',
            ...(c.lastReadAt ? { createdAt: { gt: c.lastReadAt } } : {}),
          },
        }),
      })),
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

    // Abrir la conversación = marcarla leída.
    await this.prisma.conversation.update({
      where: { id },
      data: { lastReadAt: new Date() },
    });

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

  async listNotes(tenantId: string, id: string, userId: string, role: string) {
    await this.assertAccess(tenantId, id, userId, role);
    return this.prisma.note.findMany({
      where: { conversationId: id, tenantId },
      include: { author: { select: { id: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addNote(tenantId: string, id: string, authorId: string, role: string, body: unknown) {
    await this.assertAccess(tenantId, id, authorId, role);
    if (typeof body !== 'string' || !body.trim()) {
      throw new BadRequestException('Campo requerido: body');
    }
    return this.prisma.note.create({
      data: { tenantId, conversationId: id, authorId, body: body.trim() },
      include: { author: { select: { id: true, email: true } } },
    });
  }
}
