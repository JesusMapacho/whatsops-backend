import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Actor, canManageList, canUseList, ListRoleLink } from './access';

// Nombre de la cartera de sistema. Se compara por `isSystem`, nunca por el nombre: el
// nombre es visible al usuario y podría querer traducirse.
export const CARTERA_TODOS = 'Todos mis contactos';

@Injectable()
export class ContactListsService {
  constructor(private readonly prisma: PrismaService) {}

  // Enlaces cartera→rol de ESTE tenant. La query es la frontera de tenant; `access.ts`
  // no sabe de tenants y no debe decidir sobre ellos.
  private async links(tenantId: string): Promise<ListRoleLink[]> {
    const rows = await this.prisma.contactListRole.findMany({
      where: { contactList: { tenantId } },
      select: { contactListId: true, roleId: true, canManage: true },
    });
    return rows;
  }

  async list(tenantId: string, actor: Actor) {
    const links = await this.links(tenantId);
    const rows = await this.prisma.contactList.findMany({
      where: { tenantId },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: {
        _count: { select: { members: true } },
        roles: { select: { roleId: true, canManage: true, role: { select: { name: true } } } },
      },
    });
    // El filtrado va aquí y no en el `where`: la regla "sin enlaces = solo admin" no se
    // puede expresar como filtro de Prisma sin duplicarla, y duplicada divergiría.
    return rows
      .filter((l) => canUseList(actor, l.id, links))
      .map((l) => ({
        id: l.id,
        name: l.name,
        isSystem: l.isSystem,
        members: l._count.members,
        canManage: canManageList(actor, l.id, links),
        roles: l.roles,
      }));
  }

  async create(tenantId: string, userId: string, body: any) {
    const name = str(body?.name, 'name');
    try {
      return await this.prisma.contactList.create({
        data: { tenantId, name, createdById: userId },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException('Ya existe una cartera con ese nombre');
      throw e;
    }
  }

  async remove(tenantId: string, actor: Actor, id: string) {
    const list = await this.mustManage(tenantId, actor, id);
    // La cartera de sistema no se borra: es el suelo del que salen las demás, y quien la
    // borrara perdería de golpe la única lista poblada automáticamente.
    if (list.isSystem) throw new BadRequestException('La cartera de sistema no se puede borrar.');
    await this.prisma.contactList.delete({ where: { id } });
    return { deleted: true };
  }

  // Miembros con lo que la UI necesita para decidir si se les puede escribir: el
  // `lastInboundAt` de su conversación más reciente. El ciclo de vida se deriva de ahí
  // (ver messaging/lifecycle.ts), así que no se guarda ningún estado aparte.
  async members(tenantId: string, actor: Actor, id: string) {
    await this.mustUse(tenantId, actor, id);
    const rows = await this.prisma.contactListMember.findMany({
      where: { contactListId: id },
      orderBy: { addedAt: 'desc' },
      take: 1000,
      include: {
        contact: {
          select: {
            id: true,
            name: true,
            waId: true,
            phone: true,
            platform: true,
            conversations: {
              orderBy: { updatedAt: 'desc' },
              take: 1,
              select: { id: true, lastInboundAt: true },
            },
          },
        },
      },
    });
    return rows.map((m) => ({
      contactId: m.contact.id,
      name: m.contact.name,
      waId: m.contact.waId,
      phone: m.contact.phone,
      platform: m.contact.platform,
      addedAt: m.addedAt,
      lastInboundAt: m.contact.conversations[0]?.lastInboundAt ?? null,
    }));
  }

  // Alta manual. La regla de reciprocidad se comprueba AQUÍ y en servidor: solo entra
  // quien nos ha escrito alguna vez. Es lo que hace que una cartera sea una lista de
  // gente que quiere oírnos y no una lista de números comprados.
  // `addedById` va aparte del actor a propósito: `Actor` es la pieza que decide ACCESO
  // (rol y roleId) y no debe cargar con campos que no usa para decidir.
  async addMember(tenantId: string, actor: Actor, addedById: string, id: string, body: any) {
    await this.mustManage(tenantId, actor, id);
    const contactId = str(body?.contactId, 'contactId');

    const contact = await this.prisma.contact.findFirst({
      where: { id: contactId, tenantId },
      select: {
        id: true,
        isGroup: true,
        conversations: { where: { lastInboundAt: { not: null } }, take: 1, select: { id: true } },
      },
    });
    if (!contact) throw new NotFoundException('Contacto no encontrado');
    // Un grupo no es un cliente: enviarle un masivo o un estado no tiene sentido, y su
    // "contacto" es el grupo entero (ver Contact.isGroup).
    if (contact.isGroup) throw new BadRequestException('Un grupo no se puede guardar como cliente.');
    if (!contact.conversations.length) {
      throw new BadRequestException(
        'Solo puedes guardar como cliente a quien te ha escrito alguna vez. Espera su respuesta.',
      );
    }

    // upsert y no create: el alta es idempotente, y pulsar dos veces el botón no es un
    // error que merezca un 409.
    await this.prisma.contactListMember.upsert({
      where: { contactListId_contactId: { contactListId: id, contactId } },
      create: { contactListId: id, contactId, addedById },
      update: {},
    });
    return { added: true };
  }

  async removeMember(tenantId: string, actor: Actor, id: string, contactId: string) {
    const list = await this.mustManage(tenantId, actor, id);
    await this.prisma.contactListMember.deleteMany({
      where: { contactListId: id, contactId },
    });
    // Se permite sacar a alguien de la cartera de sistema, pero se DICE la verdad: el
    // worker lo vuelve a meter en cuanto escriba otra vez.
    //
    // ponytail: no se guarda una lista de exclusiones. Techo conocido: sacar a alguien
    // de "Todos" no es permanente. Upgrade cuando alguien lo pida de verdad: una columna
    // `excluded` en el miembro que el worker respete. Mientras tanto, excluir se hace
    // enviando desde una cartera curada, que es para lo que existen.
    return {
      removed: true,
      volveraSiEscribe: list.isSystem,
      ...(list.isSystem
        ? {
            aviso:
              'Volverá a entrar en esta cartera si te escribe otra vez. Para excluirlo de los envíos, manda desde una cartera aparte.',
          }
        : {}),
    };
  }

  // Reemplaza los accesos de la cartera. Se validan los roles contra el tenant: un
  // roleId del body sin comprobar sería dar acceso a un rol de OTRA empresa.
  async setRoles(tenantId: string, actor: Actor, id: string, body: any) {
    await this.mustManage(tenantId, actor, id);
    const entradas: { roleId: string; canManage: boolean }[] = Array.isArray(body?.roles)
      ? body.roles
          .filter((r: any) => typeof r?.roleId === 'string' && r.roleId)
          .map((r: any) => ({ roleId: r.roleId, canManage: r.canManage === true }))
      : [];

    const validos = await this.prisma.role.findMany({
      where: { tenantId, id: { in: entradas.map((e) => e.roleId) } },
      select: { id: true },
    });
    const ok = new Set(validos.map((r) => r.id));
    const ajenos = entradas.filter((e) => !ok.has(e.roleId));
    if (ajenos.length) throw new BadRequestException('Algún rol no pertenece a este negocio.');

    await this.prisma.$transaction([
      this.prisma.contactListRole.deleteMany({ where: { contactListId: id } }),
      this.prisma.contactListRole.createMany({
        data: entradas.map((e) => ({ contactListId: id, roleId: e.roleId, canManage: e.canManage })),
      }),
    ]);
    return { roles: entradas.length };
  }

  // --- Reutilizables por el masivo y los estados ---

  // `waId` canónicos de los miembros, comprobando el acceso. Es la fuente de
  // destinatarios de un envío o de un estado: vienen de conversaciones reales, así que
  // no hay que resolver ni fabricar ningún chatId.
  async usableMembers(tenantId: string, actor: Actor, id: string) {
    await this.mustUse(tenantId, actor, id);
    const rows = await this.prisma.contactListMember.findMany({
      where: { contactListId: id, contact: { isGroup: false } },
      select: { contact: { select: { id: true, waId: true, phone: true, name: true } } },
    });
    return rows.map((r) => r.contact);
  }

  private async mustUse(tenantId: string, actor: Actor, id: string) {
    const list = await this.prisma.contactList.findFirst({ where: { id, tenantId } });
    if (!list) throw new NotFoundException('Cartera no encontrada');
    if (!canUseList(actor, id, await this.links(tenantId))) {
      throw new ForbiddenException('Tu rol no tiene acceso a esta cartera.');
    }
    return list;
  }

  private async mustManage(tenantId: string, actor: Actor, id: string) {
    const list = await this.prisma.contactList.findFirst({ where: { id, tenantId } });
    if (!list) throw new NotFoundException('Cartera no encontrada');
    if (!canManageList(actor, id, await this.links(tenantId))) {
      throw new ForbiddenException('Tu rol no puede gestionar esta cartera.');
    }
    return list;
  }
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new BadRequestException(`Campo requerido: ${field}`);
  }
  return v.trim();
}
