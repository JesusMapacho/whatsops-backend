import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { dealScope } from './deal-scope';
import { LAST_MESSAGE_SELECT, shapeConversationRow } from '../messaging/conversations.util';
import {
  CONTACTS_TAKE,
  ContactPatchError,
  buildContactWhere,
  parseContactFilters,
  parseContactPatch,
  parseTagIds,
} from './contacts.query';

// Etiquetas visibles en la ficha y en la lista. Un `include` anidado y no una segunda
// ronda de queries: son dos o tres por contacto.
const TAGS_SELECT = { select: { tag: { select: { id: true, name: true, color: true } } } } as const;
const USER_SELECT = { select: { id: true, email: true, firstName: true, lastName: true } } as const;

@Injectable()
export class CrmContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Lista de clientes, ordenada por actividad reciente.
   *
   * Los tratos vienen como agregado (`_count` + suma) porque la fila los pinta: sin eso,
   * la pantalla haría una petición por contacto para saber si tiene dinero encima, que es
   * el patrón que convierte una lista de 200 en 201 consultas.
   */
  async list(tenantId: string, query: Record<string, unknown>, userId: string, role: string) {
    const where = buildContactWhere(tenantId, parseContactFilters(query));
    const rows = await this.prisma.contact.findMany({
      where,
      take: CONTACTS_TAKE,
      orderBy: { updatedAt: 'desc' },
      include: {
        owner: USER_SELECT,
        tags: TAGS_SELECT,
        // Solo los ABIERTOS y solo los que este usuario puede ver: el agente no debe
        // deducir el pipeline de otro vendedor sumando las filas de la lista.
        deals: {
          where: { status: 'open', ...dealScope(role, userId) },
          select: { id: true, amount: true },
        },
      },
    });
    return rows.map((c) => this.shape(c));
  }

  /**
   * Ficha completa. Una sola consulta con includes en vez de cinco: la pantalla las pinta
   * todas de golpe, así que pedirlas por separado solo añade viajes.
   */
  async get(tenantId: string, id: string, userId: string, role: string) {
    const c = await this.prisma.contact.findFirst({
      where: { id, tenantId },
      include: {
        owner: USER_SELECT,
        tags: TAGS_SELECT,
        deals: {
          where: dealScope(role, userId),
          orderBy: [{ status: 'asc' }, { expectedCloseAt: 'asc' }],
          include: { stage: { select: { id: true, name: true } }, owner: USER_SELECT },
        },
        tasks: {
          where: { completedAt: null },
          orderBy: { dueAt: 'asc' },
          include: { assignedUser: USER_SELECT },
        },
        // Con la MISMA forma que las filas de la bandeja (`shapeConversationRow`), no un
        // resumen propio: el chat de la ficha es `<app-conversation-view>` tal cual, y
        // espera una `Conversation` completa. Devolviéndola ya hecha, la pantalla no tiene
        // que pedir cada hilo por separado —y de paso no hace falta inventar un
        // `GET /conversations/:id` que hoy no existe.
        conversations: {
          orderBy: { updatedAt: 'desc' },
          include: {
            assignedUser: { select: { id: true, email: true } },
            messages: { orderBy: { createdAt: 'desc' }, take: 1, select: LAST_MESSAGE_SELECT },
          },
        },
      },
    });
    // 404 y no 403: distinguirlos filtraría la existencia del contacto en otro tenant, que
    // ya es información.
    if (!c) throw new NotFoundException('Contacto no encontrado');

    const contactoPlano = {
      id: c.id,
      waId: c.waId,
      name: c.name,
      phone: c.phone,
      isGroup: c.isGroup,
      avatarUrl: c.avatarKey ? this.storage.signedUrl(c.avatarKey) : null,
    };
    const noLeidos = await this.noLeidosPorConversacion(c.conversations.map((v) => v.id));
    const conversations = c.conversations.map((v) => ({
      ...shapeConversationRow(v, noLeidos.get(v.id) ?? 0, (k) => this.storage.signedUrl(k)),
      // El hilo pinta la cabecera con `conversation.contact`; el include no lo trae porque
      // ya estamos DENTRO del contacto.
      contact: contactoPlano,
    }));
    return { ...this.shape(c), conversations };
  }

  // No leídos por hilo: entrantes posteriores al último `lastReadAt`. Un `groupBy` y no una
  // consulta por conversación, que sería el patrón N+1 que la bandeja ya evita.
  private async noLeidosPorConversacion(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const convs = await this.prisma.conversation.findMany({
      where: { id: { in: ids } },
      select: { id: true, lastReadAt: true },
    });
    const filas = await this.prisma.message.groupBy({
      by: ['conversationId'],
      where: {
        conversationId: { in: ids },
        direction: 'in',
        deletedAt: null,
        OR: convs.map((c) => ({
          conversationId: c.id,
          ...(c.lastReadAt ? { createdAt: { gt: c.lastReadAt } } : {}),
        })),
      },
      _count: { _all: true },
    });
    return new Map(filas.map((f) => [f.conversationId, f._count._all]));
  }

  async patch(tenantId: string, id: string, body: unknown) {
    let data;
    try {
      data = parseContactPatch(body);
    } catch (e) {
      if (e instanceof ContactPatchError) throw new BadRequestException(e.message);
      throw e;
    }
    // El dueño tiene que ser del tenant. Sin esto, un `ownerId` del body es una forma de
    // apuntar a un usuario de otro negocio.
    if (typeof data.ownerId === 'string') {
      const u = await this.prisma.user.findFirst({ where: { id: data.ownerId, tenantId } });
      if (!u) throw new BadRequestException('El dueño no pertenece a este tenant');
    }
    const { count } = await this.prisma.contact.updateMany({ where: { id, tenantId }, data });
    if (!count) throw new NotFoundException('Contacto no encontrado');
    return { id, ...data };
  }

  /**
   * Marca (o desmarca) un contacto como privado del dueño: deja de verlo el equipo.
   *
   * **Va aparte de `patch()` y solo para admin, a propósito.** `PATCH /contacts/:id` exige
   * `deals:write`, que los agentes tienen: si `privado` entrara por ahí, un agente podría
   * DESMARCARLO y leer justo las conversaciones que esto oculta. El agujero al revés.
   *
   * No corta la ingesta ni borra nada: los mensajes siguen entrando (perder el de un
   * cliente mal marcado sería peor que enseñar uno privado de más). Solo cambia quién lo ve
   * — ver `agentScope` en `messaging/conversations.util.ts`.
   */
  async setPrivado(tenantId: string, id: string, body: unknown) {
    const valor = (body as { privado?: unknown })?.privado;
    if (typeof valor !== 'boolean') {
      throw new BadRequestException('privado debe ser true o false');
    }
    const { count } = await this.prisma.contact.updateMany({
      where: { id, tenantId },
      data: { privado: valor },
    });
    if (!count) throw new NotFoundException('Contacto no encontrado');
    return { id, privado: valor };
  }

  /**
   * Reemplaza el juego de etiquetas del contacto.
   *
   * En una transacción y con los ids validados contra el tenant: sin la validación, un
   * `tagId` del body pegaría al contacto una etiqueta de otro negocio, y el nombre de una
   * etiqueta ya dice algo del negocio que la creó.
   */
  async setTags(tenantId: string, id: string, body: unknown) {
    const tagIds = parseTagIds(body);
    const contacto = await this.prisma.contact.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!contacto) throw new NotFoundException('Contacto no encontrado');

    if (tagIds.length) {
      const validas = await this.prisma.tag.findMany({
        where: { id: { in: tagIds }, tenantId },
        select: { id: true },
      });
      if (validas.length !== tagIds.length) {
        throw new BadRequestException('Alguna etiqueta no existe en este negocio');
      }
    }

    await this.prisma.$transaction([
      this.prisma.contactTag.deleteMany({ where: { contactId: id } }),
      ...(tagIds.length
        ? [this.prisma.contactTag.createMany({ data: tagIds.map((tagId) => ({ contactId: id, tagId })) })]
        : []),
    ]);
    return this.prisma.tag.findMany({
      where: { id: { in: tagIds } },
      select: { id: true, name: true, color: true },
      orderBy: { name: 'asc' },
    });
  }

  // --- catálogo de etiquetas (deals:manage para escribir) ---

  listTags(tenantId: string) {
    return this.prisma.tag.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { contacts: true } } },
    });
  }

  async createTag(tenantId: string, body: unknown) {
    const { name, color } = this.parseTag(body);
    const ya = await this.prisma.tag.findFirst({ where: { tenantId, name } });
    if (ya) throw new BadRequestException('Ya existe una etiqueta con ese nombre');
    return this.prisma.tag.create({ data: { tenantId, name, color } });
  }

  async patchTag(tenantId: string, id: string, body: unknown) {
    const { name, color } = this.parseTag(body);
    const choque = await this.prisma.tag.findFirst({
      where: { tenantId, name, id: { not: id } },
    });
    if (choque) throw new BadRequestException('Ya existe una etiqueta con ese nombre');
    const { count } = await this.prisma.tag.updateMany({
      where: { id, tenantId },
      data: { name, color },
    });
    if (!count) throw new NotFoundException('Etiqueta no encontrada');
    return { id, name, color };
  }

  // Borrar la etiqueta la quita de todos los contactos (ContactTag cae en cascada) pero no
  // toca los contactos. Es lo que espera quien limpia el catálogo.
  async removeTag(tenantId: string, id: string) {
    const { count } = await this.prisma.tag.deleteMany({ where: { id, tenantId } });
    if (!count) throw new NotFoundException('Etiqueta no encontrada');
    return { deleted: true };
  }

  private parseTag(body: unknown): { name: string; color: string } {
    const src = (body ?? {}) as Record<string, unknown>;
    const name = typeof src.name === 'string' ? src.name.trim() : '';
    if (!name) throw new BadRequestException('Campo requerido: name');
    if (name.length > 40) throw new BadRequestException('El nombre no puede pasar de 40 caracteres');
    // Token del sistema de diseño, no hex libre: con hex libre el tenant elige gris sobre
    // gris y la etiqueta deja de leerse en tema oscuro.
    const color = typeof src.color === 'string' && COLORES.includes(src.color) ? src.color : 'neutral';
    return { name, color };
  }

  // Aplana etiquetas y firma el avatar. La key sola no le sirve al navegador y las URLs
  // caducan, así que se firma al serializar — igual que `shapeConversationRow`.
  private shape<T extends { avatarKey?: string | null; tags?: Array<{ tag: unknown }> }>(c: T) {
    const { tags, ...rest } = c;
    return {
      ...rest,
      avatarUrl: c.avatarKey ? this.storage.signedUrl(c.avatarKey) : null,
      tags: (tags ?? []).map((t) => t.tag),
    };
  }
}

export const COLORES = ['neutral', 'accent', 'verde', 'ambar', 'rojo', 'azul', 'violeta'];
