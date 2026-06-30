import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { buildConversationWhere, parseStatus } from './conversations.util';

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
  ) {}

  async list(tenantId: string, filter: string | undefined, userId: string) {
    const convs = await this.prisma.conversation.findMany({
      where: buildConversationWhere(tenantId, filter, userId),
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

  async history(tenantId: string, id: string, limit = 50, before?: string) {
    const conv = await this.prisma.conversation.findFirst({ where: { id, tenantId } });
    if (!conv) throw new NotFoundException('Conversación no encontrada');

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

    return page.reverse();
  }

  async assign(tenantId: string, id: string, targetUserId: string | undefined, currentUserId: string) {
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

  async setStatus(tenantId: string, id: string, statusInput: unknown) {
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

  async listNotes(tenantId: string, id: string) {
    await this.ensureConversation(tenantId, id);
    return this.prisma.note.findMany({
      where: { conversationId: id, tenantId },
      include: { author: { select: { id: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addNote(tenantId: string, id: string, authorId: string, body: unknown) {
    await this.ensureConversation(tenantId, id);
    if (typeof body !== 'string' || !body.trim()) {
      throw new BadRequestException('Campo requerido: body');
    }
    return this.prisma.note.create({
      data: { tenantId, conversationId: id, authorId, body: body.trim() },
      include: { author: { select: { id: true, email: true } } },
    });
  }

  private async ensureConversation(tenantId: string, id: string) {
    const conv = await this.prisma.conversation.findFirst({ where: { id, tenantId } });
    if (!conv) throw new NotFoundException('Conversación no encontrada');
  }
}
