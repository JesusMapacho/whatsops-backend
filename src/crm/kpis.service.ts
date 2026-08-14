import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { dealScope, taskScope } from './deal-scope';
import { inicioDelDia } from './tasks.buckets';

/**
 * KPIs comerciales y ajustes del CRM (v8 feature 38).
 *
 * Vive aquí y no en `analytics/metrics-negocio.service.ts` —que es donde la spec lo pedía— por
 * una razón concreta: ese servicio está escrito con `$queryRaw` + `Prisma.sql`, y estos números
 * hay que acotarlos con `dealScope`, que es un `OR`. Componer un alcance con `OR` dentro de SQL
 * crudo a mano es exactamente la clase de fallo que se coló dos veces en este lote (el `OR` de
 * `buildDealWhere` y el `assignedUserId` de `buildTaskWhere`): pasa desapercibido y devuelve más
 * filas de las que debe. Con los agregados de Prisma el alcance viaja como objeto y no hay forma
 * de pisarlo. De paso, `analytics` no tiene que importar `crm` para los helpers de alcance.
 */
@Injectable()
export class KpisService {
  constructor(private readonly prisma: PrismaService) {}

  // --- ajustes ---

  async ajustes(tenantId: string) {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { autoDealOnInbound: true },
    });
    return { autoDealOnInbound: t?.autoDealOnInbound ?? false };
  }

  // Mismo molde que `BrandingService.update`: un `if (… !== undefined)` por campo, no se escribe
  // si no llegó nada, y se devuelve la vista releída en vez del resultado del update.
  async guardarAjustes(tenantId: string, body: unknown) {
    const src = (body ?? {}) as Record<string, unknown>;
    const data: { autoDealOnInbound?: boolean } = {};
    if (src.autoDealOnInbound !== undefined) {
      if (typeof src.autoDealOnInbound !== 'boolean') {
        throw new BadRequestException('autoDealOnInbound debe ser true o false');
      }
      data.autoDealOnInbound = src.autoDealOnInbound;
    }
    if (Object.keys(data).length) {
      await this.prisma.tenant.update({ where: { id: tenantId }, data });
    }
    return this.ajustes(tenantId);
  }

  // --- KPIs ---

  /**
   * Los números del dueño del negocio.
   *
   * Todo acotado por `dealScope` / `taskScope`: un agente ve los de SUS tratos, no los del
   * equipo. Un vendedor viendo el pipeline entero es una conversación de sueldos que el software
   * no tiene por qué abrir.
   */
  async resumen(tenantId: string, userId: string, role: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true, currency: true },
    });
    const timezone = tenant?.timezone ?? null;
    const { desde, hasta } = this.mesNatural(new Date(), timezone);
    const alcanceTratos = dealScope(role, userId);

    const [porEtapa, etapas, ganados, perdidos, tareasAtrasadas] = await Promise.all([
      // Embudo abierto por etapa. SIN tope de rango: un trato abierto de hace cuatro meses
      // sigue siendo dinero en curso, al revés que los cerrados.
      this.prisma.deal.groupBy({
        by: ['stageId'],
        where: { tenantId, status: 'open', ...alcanceTratos },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      // Los nombres y el orden de las etapas, para que la barra se pinte de izquierda a derecha
      // como el tablero. Solo de la pipeline por defecto: mezclar embudos en un solo número
      // sumaría procesos que no se comparan.
      this.prisma.stage.findMany({
        where: { tenantId, pipeline: { isDefault: true } },
        orderBy: { position: 'asc' },
        select: { id: true, name: true, position: true },
      }),
      this.cerrados(tenantId, 'won', desde, hasta, alcanceTratos),
      this.cerrados(tenantId, 'lost', desde, hasta, alcanceTratos),
      this.prisma.task.count({
        where: {
          tenantId,
          ...taskScope(role, userId),
          completedAt: null,
          dueAt: { lt: inicioDelDia(new Date(), timezone) },
        },
      }),
    ]);

    const suma = new Map(
      porEtapa.map((f) => [f.stageId, { total: Number(f._sum.amount ?? 0), cuantos: f._count._all }]),
    );
    const embudo = etapas.map((e) => ({
      stageId: e.id,
      stage: e.name,
      position: e.position,
      total: suma.get(e.id)?.total ?? 0,
      cuantos: suma.get(e.id)?.cuantos ?? 0,
    }));
    // Los tratos de etapas que ya no están en la pipeline por defecto (movidos de embudo, o de
    // una pipeline borrada) no aparecen por etapa pero SÍ cuentan en el total: si no, el número
    // grande de la portada no cuadraría con la suma de las columnas y nadie sabría por qué.
    const abierto = {
      total: porEtapa.reduce((s, f) => s + Number(f._sum.amount ?? 0), 0),
      cuantos: porEtapa.reduce((s, f) => s + f._count._all, 0),
    };

    const cierres = ganados.cuantos + perdidos.cuantos;
    return {
      moneda: tenant?.currency ?? null,
      mes: { desde: desde.toISOString(), hasta: hasta.toISOString() },
      embudo,
      abierto,
      ganados,
      perdidos,
      // `null` y no `0` cuando no hubo cierres: la portada no pinta el dato en vez de enseñar un
      // 0 % que asusta sin motivo. Misma convención que `home.math.ts`.
      tasaCierre: cierres > 0 ? ganados.cuantos / cierres : null,
      tareasAtrasadas,
    };
  }

  // --- privados ---

  private async cerrados(
    tenantId: string,
    status: 'won' | 'lost',
    desde: Date,
    hasta: Date,
    alcance: object,
  ) {
    const r = await this.prisma.deal.aggregate({
      where: { tenantId, status, closedAt: { gte: desde, lt: hasta }, ...alcance },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return { cuantos: r._count._all, total: Number(r._sum.amount ?? 0) };
  }

  /**
   * Del día 1 del mes a mañana, en la zona del NEGOCIO.
   *
   * Mes natural y no ventana de 30 días: es contra lo que la gente cierra objetivos y lo que se
   * compara con el mes pasado. El día 1 los números arrancan bajos, que es normal.
   *
   * `hasta` es el inicio de MAÑANA y exclusivo, no «ahora»: si fuera ahora, un trato cerrado
   * esta tarde a las 18:00 no contaría hasta que alguien recargue después.
   */
  private mesNatural(ahora: Date, timezone: string | null): { desde: Date; hasta: Date } {
    const hoy = inicioDelDia(ahora, timezone);
    // El día del tenant, para saber en qué mes estamos según él y no según UTC.
    const [y, m] = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(ahora)
      .split('-')
      .map(Number);
    // Medianoche del día 1 en la zona del tenant: se pide el inicio del día de un instante que
    // cae dentro de ese día (mediodía UTC evita quedarse corto en cualquier huso).
    const dentroDelDiaUno = new Date(Date.UTC(y, m - 1, 1, 12, 0, 0));
    return {
      desde: inicioDelDia(dentroDelDiaUno, timezone),
      hasta: new Date(hoy.getTime() + 24 * 60 * 60 * 1000),
    };
  }
}
