import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { dealScopeWhere } from './deal-scope';
import {
  ActivityError,
  TIMELINE_TAKE,
  parseActividadManual,
  parseCursor,
} from './activities.rules';

const AUTOR_SELECT = {
  select: { id: true, email: true, firstName: true, lastName: true },
} as const;

@Injectable()
export class ActivitiesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Timeline de un contacto: lo más reciente primero, paginado por CURSOR sobre
   * `occurredAt`.
   *
   * Cursor y no `skip` porque es una tabla que solo crece: con `skip` sobre 4.000 filas
   * Postgres cuenta y descarta las anteriores en cada página. El índice
   * `(tenantId, contactId, occurredAt)` sirve la consulta tal cual.
   */
  async contactTimeline(tenantId: string, contactId: string, query: Record<string, unknown>) {
    const existe = await this.prisma.contact.findFirst({
      where: { id: contactId, tenantId },
      select: { id: true },
    });
    if (!existe) throw new NotFoundException('Contacto no encontrado');
    return this.page({ tenantId, contactId }, query);
  }

  // Timeline de un trato. Pasa por `dealScopeWhere` para que un agente no lea el historial
  // del trato de otro vendedor por esta puerta.
  async dealTimeline(
    tenantId: string,
    dealId: string,
    userId: string,
    role: string,
    query: Record<string, unknown>,
  ) {
    const trato = await this.prisma.deal.findFirst({
      where: dealScopeWhere(tenantId, dealId, userId, role),
      select: { id: true },
    });
    if (!trato) throw new NotFoundException('Trato no encontrado');
    return this.page({ tenantId, dealId }, query);
  }

  private async page(where: Prisma.ActivityWhereInput, query: Record<string, unknown>) {
    const cursor = parseCursor(query.antesDe);
    const rows = await this.prisma.activity.findMany({
      where: cursor ? { ...where, occurredAt: { lt: cursor } } : where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: TIMELINE_TAKE + 1,
      include: {
        author: AUTOR_SELECT,
        deal: { select: { id: true, title: true } },
        task: { select: { id: true, title: true, type: true } },
      },
    });
    // Se pide una fila de más para saber si hay siguiente página sin un `count` aparte.
    const hayMas = rows.length > TIMELINE_TAKE;
    const items = hayMas ? rows.slice(0, TIMELINE_TAKE) : rows;
    return {
      items,
      // El cursor para la siguiente página, ya calculado: que el cliente no tenga que
      // saber que se pagina por `occurredAt`.
      siguiente: hayMas ? items[items.length - 1].occurredAt.toISOString() : null,
    };
  }

  /**
   * Registro manual de una nota, una llamada o una reunión.
   *
   * El `contactId` se resuelve del trato cuando viene `dealId`, y no se acepta de los dos
   * sitios a la vez: pedirlo dos veces es pedir que no cuadren.
   */
  async createManual(tenantId: string, userId: string, role: string, body: unknown) {
    let datos;
    try {
      datos = parseActividadManual(body, new Date());
    } catch (e) {
      if (e instanceof ActivityError) throw new BadRequestException(e.message);
      throw e;
    }
    const src = (body ?? {}) as Record<string, unknown>;
    const dealId = typeof src.dealId === 'string' && src.dealId ? src.dealId : undefined;
    const conversationId =
      typeof src.conversationId === 'string' && src.conversationId ? src.conversationId : undefined;
    let contactId = typeof src.contactId === 'string' && src.contactId ? src.contactId : undefined;

    if (dealId) {
      const trato = await this.prisma.deal.findFirst({
        where: dealScopeWhere(tenantId, dealId, userId, role),
        select: { contactId: true },
      });
      if (!trato) throw new NotFoundException('Trato no encontrado');
      // El del trato manda: si el cliente mandó otro, es un error suyo y callarlo
      // produciría una actividad colgada del contacto equivocado.
      if (contactId && contactId !== trato.contactId) {
        throw new BadRequestException('El contacto no corresponde al trato');
      }
      contactId = trato.contactId;
    }
    if (!contactId) throw new BadRequestException('Campo requerido: contactId (o dealId)');

    const contacto = await this.prisma.contact.findFirst({
      where: { id: contactId, tenantId },
      select: { id: true },
    });
    if (!contacto) throw new NotFoundException('Contacto no encontrado');

    if (conversationId) {
      const conv = await this.prisma.conversation.findFirst({
        where: { id: conversationId, tenantId, contactId },
        select: { id: true },
      });
      if (!conv) throw new BadRequestException('La conversación no es de este contacto');
    }

    return this.prisma.activity.create({
      data: {
        tenantId,
        type: datos.type,
        contactId,
        dealId,
        conversationId,
        // El autor sale del token. Un `authorId` del body sería firmar el timeline en
        // nombre de otro.
        authorId: userId,
        body: datos.body,
        occurredAt: datos.occurredAt,
      },
      include: { author: AUTOR_SELECT, deal: { select: { id: true, title: true } } },
    });
  }
}
