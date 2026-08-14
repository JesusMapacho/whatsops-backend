import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { dealScope, dealScopeWhere } from './deal-scope';
import { ensureDefaultPipeline } from './default-pipeline';
import { ordenar, primeraEtapa, puedeBorrar, reordenar, StagesError } from './stages';
import {
  DEALS_TAKE,
  DealError,
  buildDealWhere,
  parseCierre,
  parseDealFilters,
  parseDealPatch,
  parseImporte,
  tituloPorDefecto,
} from './deals.query';

const USER_SELECT = {
  select: { id: true, email: true, firstName: true, lastName: true },
} as const;

// Lo que el tablero necesita de cada tarjeta. `_count.tasks` filtrado a las pendientes es
// el punto de "trato huérfano": se calcula en la consulta que ya corre, no es columna.
const DEAL_INCLUDE = {
  contact: { select: { id: true, name: true, waId: true, company: true, avatarKey: true } },
  stage: { select: { id: true, name: true, position: true } },
  owner: USER_SELECT,
  _count: { select: { tasks: { where: { completedAt: null } } } },
} as const;

@Injectable()
export class DealsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
  ) {}

  // --- Pipelines y etapas ---

  // La pipeline por defecto se asegura al listar: es el único momento garantizado antes de
  // que alguien vea el tablero, y así los tenants que ya existían no necesitan backfill.
  async pipelines(tenantId: string) {
    await ensureDefaultPipeline(this.prisma, tenantId);
    const rows = await this.prisma.pipeline.findMany({
      where: { tenantId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      include: { stages: true },
    });
    return rows.map((p) => ({ ...p, stages: ordenar(p.stages) }));
  }

  async createPipeline(tenantId: string, body: unknown) {
    const name = this.texto(body, 'name', 60);
    const ya = await this.prisma.pipeline.findFirst({ where: { tenantId, name } });
    if (ya) throw new BadRequestException('Ya existe un embudo con ese nombre');
    // Con sus etapas iniciales: una pipeline sin etapas no admite tratos.
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.pipeline.create({ data: { tenantId, name } });
      await tx.stage.createMany({
        data: ['Nuevo prospecto', 'En proceso'].map((n, position) => ({
          tenantId,
          pipelineId: p.id,
          name: n,
          position,
        })),
      });
      return tx.pipeline.findFirst({ where: { id: p.id }, include: { stages: true } });
    });
  }

  async removePipeline(tenantId: string, id: string) {
    const abiertos = await this.prisma.deal.count({ where: { tenantId, pipelineId: id, status: 'open' } });
    if (abiertos) {
      throw new BadRequestException(
        `El embudo tiene ${abiertos} trato(s) abierto(s). Ciérralos o muévelos antes de borrarlo.`,
      );
    }
    const total = await this.prisma.pipeline.count({ where: { tenantId } });
    if (total <= 1) throw new BadRequestException('Tiene que quedar al menos un embudo');
    const { count } = await this.prisma.pipeline.deleteMany({ where: { id, tenantId } });
    if (!count) throw new NotFoundException('Embudo no encontrado');
    return { deleted: true };
  }

  /**
   * Renombrar, reordenar, crear y configurar etapas en UNA llamada transaccional.
   *
   * Reordenar reescribe todas las posiciones (ver `stages.ts`), así que partirlo en varias
   * peticiones dejaría el tablero con posiciones a medias si una falla.
   */
  async setStages(tenantId: string, pipelineId: string, body: unknown) {
    const p = await this.prisma.pipeline.findFirst({
      where: { id: pipelineId, tenantId },
      include: { stages: { select: { id: true } } },
    });
    if (!p) throw new NotFoundException('Embudo no encontrado');

    const entrada = (body as { stages?: unknown })?.stages;
    if (!Array.isArray(entrada) || !entrada.length) {
      throw new BadRequestException('Campo requerido: stages (al menos una)');
    }

    const existentes = p.stages.map((s) => s.id);
    // Las nuevas llegan sin id; se crean primero para que `reordenar` pueda validar la
    // lista completa como permutación exacta.
    const nuevas = entrada.filter((s: any) => !s?.id);
    const conId = entrada.filter((s: any) => s?.id);
    for (const s of conId) {
      if (!existentes.includes((s as any).id)) {
        throw new BadRequestException('Alguna etapa no pertenece a este embudo');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const ids: string[] = [];
      for (const s of entrada) {
        const raw = s as Record<string, unknown>;
        const name = typeof raw.name === 'string' ? raw.name.trim() : '';
        if (!name) throw new BadRequestException('Cada etapa necesita un nombre');
        const auto = this.parseAuto(raw);
        if (raw.id) {
          await tx.stage.update({
            where: { id: raw.id as string },
            data: { name, ...auto },
          });
          ids.push(raw.id as string);
        } else {
          const creada = await tx.stage.create({
            data: { tenantId, pipelineId, name, position: 0, ...auto },
          });
          ids.push(creada.id);
        }
      }
      // Las que no venían en la lista se quedan: borrar es su propio endpoint, porque
      // exige decir a dónde van los tratos. Omitir una etapa por error no puede tirarla.
      const faltan = existentes.filter((id) => !ids.includes(id));
      const orden = [...ids, ...faltan];
      let posiciones;
      try {
        posiciones = reordenar(orden, orden);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
      for (const { id, position } of posiciones) {
        await tx.stage.update({ where: { id }, data: { position } });
      }
      return tx.pipeline.findFirst({
        where: { id: pipelineId },
        include: { stages: { orderBy: { position: 'asc' } } },
      });
    });
  }

  // Borrar una etapa exige decir a dónde van sus tratos abiertos. La FK es NO ACTION justo
  // para que la base no permita dejarlos apuntando al vacío.
  async removeStage(tenantId: string, stageId: string, moveToStageId?: string) {
    const stage = await this.prisma.stage.findFirst({
      where: { id: stageId, tenantId },
      select: { id: true, pipelineId: true },
    });
    if (!stage) throw new NotFoundException('Etapa no encontrada');

    const hermanas = await this.prisma.stage.findMany({
      where: { pipelineId: stage.pipelineId },
      select: { id: true },
    });
    // Cuenta TODOS los tratos, no solo los abiertos: un trato ganado también apunta a su
    // etapa, y perder ese dato borraría el histórico con el que se mide la conversión.
    const tratos = await this.prisma.deal.count({ where: { tenantId, stageId } });

    let destino;
    try {
      destino = puedeBorrar({
        stageId,
        etapasDeLaPipeline: hermanas.map((s) => s.id),
        tratosAbiertos: tratos,
        moveToStageId,
      });
    } catch (e) {
      if (e instanceof StagesError) throw new BadRequestException(e.message);
      throw e;
    }

    await this.prisma.$transaction(async (tx) => {
      if (destino.moveToStageId) {
        await tx.deal.updateMany({
          where: { tenantId, stageId },
          data: { stageId: destino.moveToStageId },
        });
      }
      await tx.stage.delete({ where: { id: stageId } });
    });
    this.events.emitToTenant(tenantId, 'deal:updated', { stageBorrada: stageId });
    return { deleted: true, movidos: tratos };
  }

  // --- Tratos ---

  async list(tenantId: string, query: Record<string, unknown>, userId: string, role: string) {
    const where = buildDealWhere(tenantId, parseDealFilters(query), userId, role);
    const rows = await this.prisma.deal.findMany({
      where,
      take: DEALS_TAKE,
      // Lo que cierra antes, arriba; a igualdad, lo que más vale. Sin `position` en `Deal`
      // a propósito: un orden manual es un campo más que mantener para una preferencia que
      // cambia cada día.
      orderBy: [{ expectedCloseAt: 'asc' }, { amount: 'desc' }, { createdAt: 'desc' }],
      include: DEAL_INCLUDE,
    });
    return rows.map((d) => this.shape(d));
  }

  async create(tenantId: string, body: unknown, userId: string, role: string) {
    const src = (body ?? {}) as Record<string, unknown>;
    const contactId = typeof src.contactId === 'string' ? src.contactId : '';
    if (!contactId) throw new BadRequestException('Campo requerido: contactId');

    const contacto = await this.prisma.contact.findFirst({
      where: { id: contactId, tenantId },
      select: { id: true, name: true, waId: true },
    });
    if (!contacto) throw new NotFoundException('Contacto no encontrado');

    const pipeline = await this.resolverPipeline(tenantId, src.pipelineId);
    const stageId = await this.resolverEtapa(tenantId, pipeline, src.stageId);

    let amount: string | null;
    let expectedCloseAt: Date | null = null;
    try {
      amount = parseImporte(src.amount);
      if (src.expectedCloseAt) {
        const d = new Date(String(src.expectedCloseAt));
        if (Number.isNaN(d.getTime())) throw new DealError('Fecha de cierre inválida');
        expectedCloseAt = d;
      }
    } catch (e) {
      if (e instanceof DealError) throw new BadRequestException(e.message);
      throw e;
    }

    const title =
      (typeof src.title === 'string' && src.title.trim()) ||
      tituloPorDefecto(contacto.name, contacto.waId);
    // Dueño: quien lo crea, salvo que se pida otro explícitamente. `null` explícito deja el
    // trato sin reclamar, visible para todo el equipo.
    const ownerId =
      src.ownerId === null ? null : typeof src.ownerId === 'string' && src.ownerId ? src.ownerId : userId;
    if (ownerId) await this.validarUsuario(tenantId, ownerId);

    const deal = await this.prisma.$transaction(async (tx) => {
      const d = await tx.deal.create({
        data: { tenantId, contactId, pipelineId: pipeline.id, stageId, title, amount, expectedCloseAt, ownerId },
        include: DEAL_INCLUDE,
      });
      // En la MISMA transacción que el trato: un timeline al que le falta el alta cuando
      // falla la segunda escritura no es un registro.
      await tx.activity.create({
        data: {
          tenantId,
          type: 'deal_created',
          contactId,
          dealId: d.id,
          authorId: userId,
          data: { to: d.stage.name },
        },
      });
      return d;
    });
    this.events.emitToTenant(tenantId, 'deal:updated', { id: deal.id });
    return this.shape(deal);
  }

  async patch(tenantId: string, id: string, body: unknown, userId: string, role: string) {
    const actual = await this.prisma.deal.findFirst({
      where: dealScopeWhere(tenantId, id, userId, role),
      include: { stage: { select: { id: true, name: true, pipelineId: true } } },
    });
    if (!actual) throw new NotFoundException('Trato no encontrado');

    let data;
    try {
      data = parseDealPatch(body);
    } catch (e) {
      if (e instanceof DealError) throw new BadRequestException(e.message);
      throw e;
    }

    let etapaNueva: { id: string; name: string } | null = null;
    if (typeof data.stageId === 'string' && data.stageId !== actual.stageId) {
      const s = await this.prisma.stage.findFirst({
        where: { id: data.stageId, tenantId },
        select: { id: true, name: true, pipelineId: true },
      });
      if (!s) throw new BadRequestException('La etapa no existe');
      // Mover a la etapa de OTRA pipeline dejaría `pipelineId` y `stageId` contando cosas
      // distintas. Mover el trato entre embudos es otra operación, y no está en este lote.
      if (s.pipelineId !== actual.pipelineId) {
        throw new BadRequestException('La etapa es de otro embudo');
      }
      etapaNueva = { id: s.id, name: s.name };
    }
    if (typeof data.ownerId === 'string') await this.validarUsuario(tenantId, data.ownerId);

    const deal = await this.prisma.$transaction(async (tx) => {
      const d = await tx.deal.update({ where: { id }, data, include: DEAL_INCLUDE });
      if (etapaNueva) {
        await tx.activity.create({
          data: {
            tenantId,
            type: 'stage_change',
            contactId: d.contactId,
            dealId: d.id,
            authorId: userId,
            // `{from,to}` con los NOMBRES y no los ids: el timeline se lee después, y una
            // etapa renombrada o borrada dejaría el evento sin sentido si guardara ids.
            data: { from: actual.stage.name, to: etapaNueva.name },
          },
        });
      }
      return d;
    });
    this.events.emitToTenant(tenantId, 'deal:updated', { id: deal.id });
    return this.shape(deal);
  }

  /**
   * Cerrar (ganado / perdido) o reabrir.
   *
   * Ruta propia y no un `PATCH` genérico: `status` y `closedAt` no pueden discrepar, así
   * que los pone el mismo sitio, y el cierre escribe su `Activity`.
   */
  async setStatus(tenantId: string, id: string, body: unknown, userId: string, role: string) {
    const actual = await this.prisma.deal.findFirst({
      where: dealScopeWhere(tenantId, id, userId, role),
      select: { id: true, contactId: true, status: true, amount: true },
    });
    if (!actual) throw new NotFoundException('Trato no encontrado');

    let cierre;
    try {
      cierre = parseCierre(body, new Date());
    } catch (e) {
      if (e instanceof DealError) throw new BadRequestException(e.message);
      throw e;
    }

    const deal = await this.prisma.$transaction(async (tx) => {
      const d = await tx.deal.update({
        where: { id },
        data: { status: cierre.status, lostReason: cierre.lostReason, closedAt: cierre.closedAt },
        include: DEAL_INCLUDE,
      });
      // Reabrir no escribe actividad de cierre: no se ha cerrado nada. El cambio queda en
      // `updatedAt` y en que el trato vuelve al tablero.
      if (cierre.status !== 'open') {
        await tx.activity.create({
          data: {
            tenantId,
            type: cierre.status === 'won' ? 'deal_won' : 'deal_lost',
            contactId: d.contactId,
            dealId: d.id,
            authorId: userId,
            // El motivo va en `body` porque es texto libre que se lee; el monto en `data`
            // porque es un dato que se agrega.
            body: cierre.lostReason,
            data: d.amount ? { amount: d.amount.toString() } : undefined,
          },
        });
      }
      return d;
    });
    this.events.emitToTenant(tenantId, 'deal:updated', { id: deal.id, status: deal.status });
    return this.shape(deal);
  }

  async remove(tenantId: string, id: string) {
    const { count } = await this.prisma.deal.deleteMany({ where: { id, tenantId } });
    if (!count) throw new NotFoundException('Trato no encontrado');
    this.events.emitToTenant(tenantId, 'deal:updated', { id, borrado: true });
    return { deleted: true };
  }

  // Totales por etapa para las cabeceras del tablero. En SQL y no sumando en el cliente:
  // el tope de `DEALS_TAKE` recortaría la suma y el dueño del negocio vería menos dinero
  // del que tiene.
  async totales(tenantId: string, query: Record<string, unknown>, userId: string, role: string) {
    const where = buildDealWhere(tenantId, parseDealFilters(query), userId, role);
    const filas = await this.prisma.deal.groupBy({
      by: ['stageId'],
      where,
      _sum: { amount: true },
      _count: { _all: true },
    });
    return filas.map((f) => ({
      stageId: f.stageId,
      total: f._sum.amount?.toString() ?? '0',
      cuantos: f._count._all,
    }));
  }

  // --- privados ---

  private async resolverPipeline(tenantId: string, pedida: unknown) {
    if (typeof pedida === 'string' && pedida) {
      const p = await this.prisma.pipeline.findFirst({
        where: { id: pedida, tenantId },
        include: { stages: { orderBy: { position: 'asc' } } },
      });
      if (!p) throw new BadRequestException('El embudo no existe');
      if (!p.stages.length) throw new BadRequestException('Ese embudo no tiene etapas');
      return p;
    }
    return ensureDefaultPipeline(this.prisma, tenantId);
  }

  private async resolverEtapa(
    tenantId: string,
    pipeline: { id: string; stages: Array<{ id: string; name: string; position: number }> },
    pedida: unknown,
  ): Promise<string> {
    if (typeof pedida === 'string' && pedida) {
      const s = pipeline.stages.find((x) => x.id === pedida);
      if (!s) throw new BadRequestException('La etapa no es de ese embudo');
      return s.id;
    }
    try {
      return primeraEtapa(pipeline.stages).id;
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  private async validarUsuario(tenantId: string, userId: string) {
    const u = await this.prisma.user.findFirst({ where: { id: userId, tenantId } });
    if (!u) throw new BadRequestException('El usuario no pertenece a este tenant');
  }

  private texto(body: unknown, campo: string, max: number): string {
    const v = (body as Record<string, unknown>)?.[campo];
    const t = typeof v === 'string' ? v.trim() : '';
    if (!t) throw new BadRequestException(`Campo requerido: ${campo}`);
    if (t.length > max) throw new BadRequestException(`${campo} no puede pasar de ${max} caracteres`);
    return t;
  }

  private parseAuto(raw: Record<string, unknown>) {
    const titulo = typeof raw.autoTaskTitle === 'string' ? raw.autoTaskTitle.trim() : '';
    const dias = Number(raw.autoTaskDays);
    // Los dos o ninguno: un título sin plazo no dice cuándo, y un plazo sin título no dice
    // qué. Media configuración crearía tareas sin sentido en cada movimiento.
    if (!titulo) return { autoTaskTitle: null, autoTaskDays: null };
    if (!Number.isInteger(dias) || dias < 0 || dias > 365) {
      throw new BadRequestException('Los días de la tarea automática deben ir de 0 a 365');
    }
    return { autoTaskTitle: titulo, autoTaskDays: dias };
  }

  // Aplana el conteo de tareas pendientes a un booleano y expone el nombre del contacto.
  private shape<T extends { _count?: { tasks: number } }>(d: T) {
    const { _count, ...rest } = d as T & Record<string, unknown>;
    return { ...rest, tieneTareaPendiente: (_count?.tasks ?? 0) > 0 };
  }
}
