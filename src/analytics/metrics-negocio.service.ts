import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DateRange {
  from?: string;
  to?: string;
}

@Injectable()
export class MetricsNegocioService {
  constructor(private readonly prisma: PrismaService) {}

  // Agregados de negocio del tenant. Todo en SQL/Prisma (sin traer mensajes a
  // memoria). Rango topado a 90 días.
  async summary(tenantId: string, range: DateRange) {
    const { from, to } = this.clampRange(range);

    const [messagesByDay, conversationsByStatus, firstResponseByAgent] = await Promise.all([
      this.messagesByDay(tenantId, from, to),
      this.conversationsByStatus(tenantId, from, to),
      this.firstResponseByAgent(tenantId, from, to),
    ]);

    const totals = {
      messagesIn: messagesByDay.reduce((a, d) => a + d.in, 0),
      messagesOut: messagesByDay.reduce((a, d) => a + d.out, 0),
      conversations: conversationsByStatus.reduce((a, s) => a + s.count, 0),
    };

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals,
      messagesByDay,
      conversationsByStatus,
      firstResponseByAgent,
    };
  }

  // Serie temporal de mensajes in/out por día (date_trunc en Postgres).
  private async messagesByDay(tenantId: string, from: Date, to: Date) {
    const rows = await this.prisma.$queryRaw<{ day: Date; direction: string; count: bigint }[]>(
      Prisma.sql`
        SELECT date_trunc('day', "createdAt") AS day, "direction"::text AS direction, count(*)::bigint AS count
        FROM "Message"
        WHERE "tenantId" = ${tenantId} AND "createdAt" BETWEEN ${from} AND ${to}
        GROUP BY 1, 2
        ORDER BY 1 ASC
      `,
    );
    // Pivotar a { day, in, out }.
    const byDay = new Map<string, { day: string; in: number; out: number }>();
    for (const r of rows) {
      const key = r.day.toISOString().slice(0, 10);
      const entry = byDay.get(key) ?? { day: key, in: 0, out: 0 };
      if (r.direction === 'in') entry.in = Number(r.count);
      else if (r.direction === 'out') entry.out = Number(r.count);
      byDay.set(key, entry);
    }
    return [...byDay.values()];
  }

  private async conversationsByStatus(tenantId: string, from: Date, to: Date) {
    const rows = await this.prisma.conversation.groupBy({
      by: ['status'],
      where: { tenantId, createdAt: { gte: from, lte: to } },
      _count: { _all: true },
    });
    return rows.map((r) => ({ status: r.status, count: r._count._all }));
  }

  // Tiempo de primera respuesta por agente: primer outbound - primer inbound de
  // cada conversación, promediado por assignedUserId. Todo en una query.
  private async firstResponseByAgent(tenantId: string, from: Date, to: Date) {
    const rows = await this.prisma.$queryRaw<
      { agent: string | null; avgSeconds: number | null; n: bigint }[]
    >(
      Prisma.sql`
        WITH firsts AS (
          SELECT m."conversationId",
                 MIN(CASE WHEN m."direction" = 'in'  THEN m."createdAt" END) AS first_in,
                 MIN(CASE WHEN m."direction" = 'out' THEN m."createdAt" END) AS first_out
          FROM "Message" m
          WHERE m."tenantId" = ${tenantId} AND m."createdAt" BETWEEN ${from} AND ${to}
          GROUP BY m."conversationId"
        )
        SELECT c."assignedUserId" AS agent,
               AVG(EXTRACT(EPOCH FROM (f.first_out - f.first_in)))::float AS "avgSeconds",
               count(*)::bigint AS n
        FROM firsts f
        JOIN "Conversation" c ON c.id = f."conversationId"
        WHERE f.first_in IS NOT NULL AND f.first_out IS NOT NULL AND f.first_out > f.first_in
        GROUP BY c."assignedUserId"
        ORDER BY "avgSeconds" ASC
      `,
    );
    return rows.map((r) => ({
      agent: r.agent,
      avgSeconds: r.avgSeconds != null ? Math.round(r.avgSeconds) : null,
      count: Number(r.n),
    }));
  }

  // Default: últimos 30 días. Tope duro: 90 días.
  private clampRange(range: DateRange): { from: Date; to: Date } {
    const to = range.to ? new Date(range.to) : new Date();
    let from = range.from ? new Date(range.from) : new Date(to.getTime() - 30 * DAY_MS);
    if (isNaN(to.getTime()) || isNaN(from.getTime())) {
      const now = new Date();
      return { from: new Date(now.getTime() - 30 * DAY_MS), to: now };
    }
    if (to.getTime() - from.getTime() > MAX_DAYS * DAY_MS) {
      from = new Date(to.getTime() - MAX_DAYS * DAY_MS);
    }
    return { from, to };
  }
}
