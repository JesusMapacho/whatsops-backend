import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PgBoss, Job, JobInsert, JobWithMetadata, Queue as PgBossQueue, ScheduleOptions, SendOptions, WorkOptions } from 'pg-boss';

// Envoltorio fino sobre pg-boss (colas de trabajo persistidas en la misma base que Prisma,
// v.gr. Neon): un backend menos que mantener que Redis/BullMQ, y las colas sobreviven un
// `docker compose down` o un dyno reciclado sin ningún "reponer al arrancar".
//
// Un solo cliente para todo el proceso (como PrismaService): cada `createQueue`/`work` de un
// módulo llama a esta instancia, nunca crea la suya.
@Injectable()
export class PgBossService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PgBossService.name);
  private readonly boss: PgBoss;

  constructor(config: ConfigService) {
    this.boss = new PgBoss({
      connectionString: config.get<string>('DATABASE_URL')!,
      // Nombre de esquema propio: no compite con las tablas de Prisma ni con `public`.
      schema: 'pgboss',
    });
    this.boss.on('error', (err) => this.logger.error(`pg-boss: ${err.message}`, err.stack));
  }

  async onModuleInit() {
    await this.boss.start();
  }

  async onModuleDestroy() {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }

  createQueue(name: string, options?: Omit<PgBossQueue, 'name'>) {
    return this.boss.createQueue(name, options);
  }

  send(name: string, data?: object | null, options?: SendOptions) {
    return this.boss.send(name, data, options);
  }

  insert(name: string, jobs: JobInsert[]) {
    return this.boss.insert(name, jobs);
  }

  work<ReqData>(name: string, handler: (job: Job<ReqData>) => Promise<unknown>): Promise<string>;
  work<ReqData>(
    name: string,
    options: WorkOptions,
    handler: (job: Job<ReqData>) => Promise<unknown>,
  ): Promise<string>;
  work<ReqData>(name: string, optionsOrHandler: any, maybeHandler?: any) {
    // pg-boss entrega SIEMPRE un array (tamaño 1 por defecto, o `batchSize` si se pide más):
    // aquí se aplana a un job porque ningún worker de este backend procesa en lote.
    if (typeof optionsOrHandler === 'function') {
      const handler = optionsOrHandler as (job: Job<ReqData>) => Promise<unknown>;
      return this.boss.work<ReqData>(name, async ([job]) => handler(job));
    }
    const handler = maybeHandler as (job: Job<ReqData>) => Promise<unknown>;
    return this.boss.work<ReqData>(name, optionsOrHandler, async ([job]) => handler(job));
  }

  workWithMetadata<ReqData>(
    name: string,
    options: WorkOptions,
    handler: (job: JobWithMetadata<ReqData>) => Promise<unknown>,
  ) {
    return this.boss.work<ReqData>(name, { ...options, includeMetadata: true } as any, async ([job]: any) =>
      handler(job),
    );
  }

  schedule(name: string, cron: string, data?: object | null, options?: ScheduleOptions) {
    return this.boss.schedule(name, cron, data, options);
  }

  unschedule(name: string, key?: string) {
    return this.boss.unschedule(name, key);
  }

  getSchedules(name?: string, key?: string) {
    return this.boss.getSchedules(name, key);
  }

  getQueue(name: string) {
    return this.boss.getQueue(name);
  }
}
