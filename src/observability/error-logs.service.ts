import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface ErrorLogFilters {
  statusCode?: number;
  path?: string;
  userId?: string;
  from?: Date;
  to?: Date;
  text?: string;
}

@Injectable()
export class ErrorLogsService implements OnModuleInit {
  private readonly logger = new Logger('ErrorLogs');
  private readonly retentionDays: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.retentionDays = Number(config.get('ERRORLOG_RETENTION_DAYS') ?? 30);
  }

  // Retención: purga al arrancar y cada 24h. ponytail: setInterval simple;
  // subir a job repeatable de BullMQ si hace falta cron real.
  onModuleInit() {
    void this.purge();
    const day = 24 * 60 * 60 * 1000;
    const t = setInterval(() => void this.purge(), day);
    if (typeof t.unref === 'function') t.unref();
  }

  async purge() {
    if (!this.retentionDays || this.retentionDays <= 0) return;
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);
    try {
      const { count } = await this.prisma.errorLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      if (count) this.logger.log(`Purga de ErrorLog: ${count} registros > ${this.retentionDays}d`);
    } catch (e: any) {
      this.logger.error(`Purga falló: ${e?.message ?? e}`);
    }
  }

  // Auditoría de acceso (no error): registra una acción del super-admin en la
  // misma tabla, marcada con errorCode PLATFORM_AUDIT y statusCode 200. Mejor
  // esfuerzo, no bloquea.
  audit(entry: {
    actorUserId: string;
    tenantId: string | null;
    method: string;
    path: string;
    action: string;
    requestId?: string;
  }) {
    return this.prisma.errorLog
      .create({
        data: {
          tenantId: entry.tenantId,
          userId: entry.actorUserId,
          method: entry.method,
          path: entry.path,
          statusCode: 200,
          errorMessage: entry.action.slice(0, 2000),
          errorCode: 'PLATFORM_AUDIT',
          requestId: entry.requestId ?? 'platform-audit',
        },
      })
      .catch((e) => this.logger.error(`Auditoría falló: ${e?.message ?? e}`));
  }

  // tenantId null = todos los tenants (solo alcanzable por el guard de plataforma, feature 03).
  async list(tenantId: string | null, filters: ErrorLogFilters, limit = 50, before?: string) {
    const where: Prisma.ErrorLogWhereInput = {};
    if (tenantId !== null) where.tenantId = tenantId;
    if (filters.statusCode) where.statusCode = filters.statusCode;
    if (filters.path) where.path = { contains: filters.path, mode: 'insensitive' };
    if (filters.userId) where.userId = filters.userId;
    if (filters.text) where.errorMessage = { contains: filters.text, mode: 'insensitive' };
    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) where.createdAt.gte = filters.from;
      if (filters.to) where.createdAt.lte = filters.to;
    }
    if (before) {
      const d = new Date(before);
      if (!isNaN(d.getTime())) where.createdAt = { ...(where.createdAt as object), lt: d };
    }
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    // Lista sin stack/body pesados; el detalle los trae.
    return this.prisma.errorLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        tenantId: true,
        userId: true,
        method: true,
        path: true,
        statusCode: true,
        errorMessage: true,
        errorCode: true,
        requestId: true,
        createdAt: true,
      },
    });
  }

  async get(tenantId: string | null, id: string) {
    const where: Prisma.ErrorLogWhereInput = { id };
    if (tenantId !== null) where.tenantId = tenantId;
    const log = await this.prisma.errorLog.findFirst({ where });
    if (!log) throw new NotFoundException('ErrorLog no encontrado');
    return log;
  }
}
