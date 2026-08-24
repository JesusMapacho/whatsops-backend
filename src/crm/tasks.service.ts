import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { RolesService } from '../roles/roles.service';
import { taskScope } from './deal-scope';
import { parseScope, rangoDeScope } from './tasks.buckets';
import {
  TASKS_TAKE,
  TaskError,
  buildTaskWhere,
  parseComplete,
  parseTaskFilters,
  parseTaskNueva,
  parseTaskPatch,
} from './tasks.query';

const USER_SELECT = {
  select: { id: true, email: true, firstName: true, lastName: true },
} as const;

// Lo que la fila de la agenda necesita para pintarse sin una petición por tarea.
const TASK_INCLUDE = {
  assignedUser: USER_SELECT,
  // `null` = la creó el sistema (un cambio de etapa, un flujo), no «no llegó el dato»:
  // `createdById` es nulable justo para poder decir eso.
  createdBy: USER_SELECT,
  contact: { select: { id: true, name: true, waId: true, company: true } },
  // `amount` es `Decimal` y cruza como string, igual que en la ficha del cliente.
  deal: { select: { id: true, title: true, amount: true } },
} as const;

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly roles: RolesService,
  ) {}

  /**
   * Lista de la agenda.
   *
   * El rango de fechas lo pone `rangoDeScope` **en la zona del tenant**, y se filtra en SQL:
   * la tabla solo crece y el índice `(tenantId, assignedUserId, completedAt, dueAt)` está
   * puesto justo para esta consulta.
   */
  async list(
    tenantId: string,
    query: Record<string, unknown>,
    userId: string,
    role: string,
    roleId: string | null,
  ) {
    const timezone = await this.zonaDe(tenantId);
    const scope = parseScope(query.scope);
    const filtros = parseTaskFilters(query);
    const rango = rangoDeScope(scope, new Date(), timezone);
    const alcance = await this.alcance(filtros.equipo, userId, role, roleId);

    return this.prisma.task.findMany({
      where: buildTaskWhere(tenantId, filtros, alcance, rango),
      take: TASKS_TAKE,
      // Las atrasadas más viejas primero (son las que más urgen) y dentro del día por hora.
      // `hechas` sale al revés porque ahí interesa lo último que se cerró.
      //
      // `agenda` lleva las dos clases a la vez, y con el tope de `TASKS_TAKE` el orden decide
      // qué se pierde. Con `dueAt asc` a secas una tarea cerrada hace tres días vence hace
      // tres días, así que se cuela DELANTE de las de hoy: en un tenant con historia las 200
      // filas se las come el pasado y «Hoy» sale vacía — que es el bug por el que este scope
      // existe. Abiertas primero y cerradas detrás, lo último cerrado arriba: el recorte cae
      // sobre las cerradas más viejas, que son las que menos duelen.
      //
      // `nulls` va explícito y no por el implícito de Postgres para `DESC`: es un default de
      // motor, y de los que cambian sin que nadie mire.
      orderBy:
        scope === 'agenda'
          ? [{ completedAt: { sort: 'desc', nulls: 'first' } }, { dueAt: 'asc' }]
          : scope === 'hechas'
            ? { completedAt: 'desc' }
            : { dueAt: 'asc' },
      include: TASK_INCLUDE,
    });
  }

  /**
   * Los tres números del menú: atrasadas, de hoy sin completar, y cerradas hoy.
   *
   * Endpoint propio y no un conteo sobre la lista: lo pide el menú desde cualquier pantalla, y
   * traerse 200 tareas para contarlas sería tirar de la red por nada.
   */
  async resumen(tenantId: string, userId: string, role: string) {
    const timezone = await this.zonaDe(tenantId);
    const ahora = new Date();
    const alcance = taskScope(role, userId);
    const atr = rangoDeScope('atrasadas', ahora, timezone);
    const hoy = rangoDeScope('hoy', ahora, timezone);
    const [atrasadas, deHoy, cerradasHoy] = await Promise.all([
      this.prisma.task.count({
        where: { tenantId, ...alcance, completedAt: null, dueAt: { lt: atr.hasta! } },
      }),
      this.prisma.task.count({
        where: { tenantId, ...alcance, completedAt: null, dueAt: { gte: hoy.desde!, lt: hoy.hasta! } },
      }),
      // Sin cota superior: una tarea no se cierra en el futuro. Y se cuenta por `completedAt`,
      // no por `dueAt`: lo cerrado hoy incluye lo que vencía la semana pasada, que es
      // justamente el trabajo que se quiere ver reconocido al final del día.
      this.prisma.task.count({
        where: { tenantId, ...alcance, completedAt: { gte: hoy.desde! } },
      }),
    ]);
    return { atrasadas, hoy: deHoy, cerradasHoy };
  }

  async create(tenantId: string, body: unknown, userId: string, role: string) {
    const timezone = await this.zonaDe(tenantId);
    let datos;
    try {
      datos = parseTaskNueva(body, timezone);
    } catch (e) {
      if (e instanceof TaskError) throw new BadRequestException(e.message);
      throw e;
    }

    let contactId = datos.contactId;
    let responsablePorDefecto = userId;

    if (datos.dealId) {
      // El trato se busca CON el alcance: sin eso, un `dealId` ajeno sería una forma de
      // colgarle tareas al trato de otro (y de otro tenant).
      const trato = await this.prisma.deal.findFirst({
        where: { id: datos.dealId, tenantId },
        select: { id: true, contactId: true, ownerId: true },
      });
      if (!trato) throw new BadRequestException('El trato no existe en este negocio');
      if (contactId && contactId !== trato.contactId) {
        throw new BadRequestException('El contacto no corresponde al trato');
      }
      // Se rellena del trato en vez de pedirlo: la `Activity` del cierre necesita el
      // contacto, y pedirlo dos veces es pedir que no cuadren.
      contactId = trato.contactId;
      // La tarea es de quien lleva la venta, no de quien la apunta: un jefe revisando diez
      // tratos acabaría con diez tareas suyas. Si el trato no tiene dueño, se queda quien
      // la crea.
      responsablePorDefecto = trato.ownerId ?? userId;
    }

    if (contactId) {
      const c = await this.prisma.contact.findFirst({ where: { id: contactId, tenantId }, select: { id: true } });
      if (!c) throw new BadRequestException('El contacto no existe en este negocio');
    }

    const assignedUserId = datos.assignedUserId ?? responsablePorDefecto;
    await this.validarUsuario(tenantId, assignedUserId);

    const tarea = await this.prisma.task.create({
      data: {
        tenantId,
        title: datos.title,
        type: datos.type,
        dueAt: datos.dueAt,
        assignedUserId,
        contactId,
        dealId: datos.dealId,
        createdById: userId,
      },
      include: TASK_INCLUDE,
    });
    // `deal:updated` además de `task:updated`: crear una tarea apaga el punto de huérfano de
    // la tarjeta, y el tablero de otra pestaña tiene que enterarse.
    this.events.emitToTenant(tenantId, 'task:updated', { id: tarea.id });
    if (tarea.dealId) this.events.emitToTenant(tenantId, 'deal:updated', { id: tarea.dealId });
    return tarea;
  }

  async patch(tenantId: string, id: string, body: unknown, userId: string, role: string) {
    const actual = await this.buscar(tenantId, id, userId, role);
    const timezone = await this.zonaDe(tenantId);
    let data;
    try {
      data = parseTaskPatch(body, timezone);
    } catch (e) {
      if (e instanceof TaskError) throw new BadRequestException(e.message);
      throw e;
    }
    if (typeof data.assignedUserId === 'string') await this.validarUsuario(tenantId, data.assignedUserId);

    const tarea = await this.prisma.task.update({ where: { id: actual.id }, data, include: TASK_INCLUDE });
    this.events.emitToTenant(tenantId, 'task:updated', { id: tarea.id });
    return tarea;
  }

  /**
   * Completar.
   *
   * Ruta propia y no un `PATCH`: sella `completedAt` y escribe su `Activity` en la misma
   * transacción, así que el timeline no puede quedarse sin el registro de algo que sí pasó.
   *
   * Devuelve `dejaTratoHuerfano`: si la tarea era de un trato y ese trato se queda sin
   * ninguna pendiente. Lo calcula el servidor porque es quien sabe si quedan otras, y es lo
   * que dispara la propuesta de programar la siguiente — el momento en que se tiene la
   * respuesta en la cabeza.
   */
  async complete(tenantId: string, id: string, body: unknown, userId: string, role: string) {
    const actual = await this.buscar(tenantId, id, userId, role);
    if (actual.completedAt) throw new BadRequestException('Esa tarea ya estaba completada');
    let outcome;
    try {
      ({ outcome } = parseComplete(body));
    } catch (e) {
      if (e instanceof TaskError) throw new BadRequestException(e.message);
      throw e;
    }

    const ahora = new Date();
    const tarea = await this.prisma.$transaction(async (tx) => {
      const t = await tx.task.update({
        where: { id: actual.id },
        data: { completedAt: ahora, outcome },
        include: TASK_INCLUDE,
      });
      // `Activity.contactId` es obligatorio, así que una tarea sin contacto (una interna, sin
      // cliente detrás) se completa sin dejar entrada en ningún timeline. No hay timeline al
      // que apuntar, y no es un fallo: es que esa tarea no era de nadie de fuera.
      if (t.contactId) {
        await tx.activity.create({
          data: {
            tenantId,
            type: 'task_done',
            contactId: t.contactId,
            dealId: t.dealId,
            taskId: t.id,
            authorId: userId,
            // El resultado va en `body` porque es texto libre que se lee tal cual en la
            // ficha; el título de la tarea ya viaja en la relación.
            body: outcome,
          },
        });
      }
      return t;
    });

    // Cero pendientes en el trato = vuelve a estar huérfano. Se cuenta después de cerrar,
    // porque la que se acaba de completar ya no cuenta.
    let dejaTratoHuerfano = false;
    if (tarea.dealId) {
      const pendientes = await this.prisma.task.count({
        where: { tenantId, dealId: tarea.dealId, completedAt: null },
      });
      dejaTratoHuerfano = pendientes === 0;
    }

    this.events.emitToTenant(tenantId, 'task:updated', { id: tarea.id, completada: true });
    if (tarea.dealId) this.events.emitToTenant(tenantId, 'deal:updated', { id: tarea.dealId });
    return { ...tarea, dejaTratoHuerfano };
  }

  /**
   * Reabrir: deshace el cierre y devuelve la tarea a la agenda.
   *
   * **La `Activity{task_done}` del cierre NO se toca.** El timeline es append-only por
   * declaración (`DDS.md` §4.1) y las métricas comerciales se calculan sobre él
   * (`activities.rules.ts:8`), así que borrar la fila reescribiría el histórico: que la tarea
   * se cerró el martes sigue siendo verdad después de reabrirla. Si está abierta AHORA lo dice
   * la tarea, que es otra pregunta y tiene otro sitio donde contestarse.
   * ponytail: reabrir y volver a cerrar deja dos `task_done` con el mismo `taskId`. Techo: una
   * métrica que cuente cierres los contaría dos veces. Camino: `distinct` por `taskId` en esa
   * consulta — se puede, la columna existe. Hoy no hay ninguna que los cuente así.
   *
   * `outcome` sí se limpia: «qué pasó al cerrar» no significa nada sobre una tarea abierta. Y
   * no se pierde, que es lo que lo hace barato: el texto vive en el `body` de esa `Activity`.
   */
  async reopen(tenantId: string, id: string, userId: string, role: string) {
    const actual = await this.buscar(tenantId, id, userId, role);
    if (!actual.completedAt) throw new BadRequestException('Esa tarea no estaba completada');

    const tarea = await this.prisma.task.update({
      where: { id: actual.id },
      data: { completedAt: null, outcome: null },
      include: TASK_INCLUDE,
    });
    // `deal:updated` porque reabrir APAGA el punto de huérfano de la tarjeta, igual que lo
    // apaga crear una tarea. No devuelve `dejaTratoHuerfano`: es la operación contraria, y
    // reabrir nunca deja un trato sin próxima acción.
    this.events.emitToTenant(tenantId, 'task:updated', { id: tarea.id });
    if (tarea.dealId) this.events.emitToTenant(tenantId, 'deal:updated', { id: tarea.dealId });
    return tarea;
  }

  // Borrar solo quien la creó, o un admin. Una tarea ajena se reprograma o se reasigna; que
  // cualquiera pueda hacerla desaparecer de la agenda de otro es una forma de perder trabajo.
  async remove(tenantId: string, id: string, userId: string, role: string) {
    const actual = await this.buscar(tenantId, id, userId, role);
    if (role !== 'admin' && actual.createdById !== userId) {
      throw new NotFoundException('Tarea no encontrada');
    }
    await this.prisma.task.delete({ where: { id: actual.id } });
    this.events.emitToTenant(tenantId, 'task:updated', { id, borrada: true });
    if (actual.dealId) this.events.emitToTenant(tenantId, 'deal:updated', { id: actual.dealId });
    return { deleted: true };
  }

  // --- privados ---

  // 404 y no 403 para la tarea de otro: distinguirlos filtra que existe, que ya es información.
  private async buscar(tenantId: string, id: string, userId: string, role: string) {
    const t = await this.prisma.task.findFirst({
      where: { id, tenantId, ...taskScope(role, userId) },
    });
    if (!t) throw new NotFoundException('Tarea no encontrada');
    return t;
  }

  /**
   * El alcance de filas: las mías, o las de todos si se pide «del equipo» Y se puede.
   *
   * `taskScope` se apoya en `role === 'admin'`, igual que `dealScope`. Para el conmutador se
   * resuelve el permiso de verdad, porque un rol a medida con `deals:manage` tiene que poder
   * ver el equipo — si no, la UI enseñaría un conmutador que el servidor ignora. Solo se
   * consulta cuando se pide, así que el camino normal no paga la query.
   */
  private async alcance(equipo: boolean, userId: string, role: string, roleId: string | null) {
    if (!equipo) return taskScope(role, userId);
    const permisos = await this.roles.permissionKeysFor(role, roleId);
    // Sin el permiso se ignora la petición en silencio y se devuelven las suyas: la UI no
    // ofrece el conmutador, así que llegar aquí es una llamada a mano.
    return permisos.includes('deals:manage') ? {} : taskScope(role, userId);
  }

  private async zonaDe(tenantId: string): Promise<string | null> {
    // ponytail: una lectura por PK en cada llamada. Cachear por tenant cuando se note; hoy es
    // la consulta más barata del camino y evita un estado que invalidar al cambiar la zona.
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    return t?.timezone ?? null;
  }

  private async validarUsuario(tenantId: string, userId: string) {
    const u = await this.prisma.user.findFirst({ where: { id: userId, tenantId }, select: { id: true } });
    if (!u) throw new BadRequestException('El responsable no pertenece a este negocio');
  }
}
