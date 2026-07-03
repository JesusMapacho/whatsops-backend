import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { PrismaService } from '../../prisma/prisma.service';
import { buildEmbeddings } from './embeddings';
import { SCHEMA_DOCS } from './schema-doc';
import { SqlExecutor } from './executor';
import { MAX_ROWS } from './sql-guard';

const SqlSchema = z.object({
  sql: z
    .string()
    .describe('Una sola sentencia SELECT de PostgreSQL, sin punto y coma final.'),
});

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

// Rama B: RAG de esquema (pgvector) → generación de SELECT (LLM) → ejecución segura.
@Injectable()
export class BranchBService implements OnModuleDestroy {
  private readonly log = new Logger('Assistant:BranchB');
  private readonly executor: SqlExecutor;
  private embeddings?: ReturnType<typeof buildEmbeddings>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.executor = new SqlExecutor(config.get<string>('DATABASE_URL_RO'));
  }

  private embed() {
    this.embeddings ??= buildEmbeddings(this.config);
    return this.embeddings;
  }

  onModuleDestroy() {
    return this.executor.close();
  }

  // (Re)indexa el esquema documentado. Idempotente (upsert por id de tabla).
  async indexSchema(): Promise<number> {
    const vectors = await this.embed().embedDocuments(SCHEMA_DOCS.map((d) => d.content));
    for (let i = 0; i < SCHEMA_DOCS.length; i++) {
      const doc = SCHEMA_DOCS[i];
      const vec = vectorLiteral(vectors[i]);
      await this.prisma.$executeRaw`
        INSERT INTO schema_embedding (id, content, embedding)
        VALUES (${doc.id}, ${doc.content}, ${vec}::vector)
        ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding`;
    }
    this.log.log(`Esquema indexado: ${SCHEMA_DOCS.length} tablas`);
    return SCHEMA_DOCS.length;
  }

  // Recupera el subconjunto de esquema más relevante a la pregunta (top-k por similitud).
  async retrieve(question: string, k = 4): Promise<string[]> {
    const vec = vectorLiteral(await this.embed().embedQuery(question));
    const rows = await this.prisma.$queryRaw<{ content: string }[]>`
      SELECT content FROM schema_embedding
      ORDER BY embedding <=> ${vec}::vector
      LIMIT ${k}`;
    return rows.map((r) => r.content);
  }

  // Genera un SELECT a partir de la pregunta y del esquema recuperado. Solo genera.
  async generateSql(model: BaseChatModel, question: string, schemaChunks: string[]): Promise<string> {
    const system = [
      'Eres un generador de SQL para PostgreSQL. Devuelve UNA sola sentencia SELECT.',
      'Usa EXCLUSIVAMENTE las tablas y columnas del ESQUEMA dado; entrecomilla los identificadores ("Conversation", "tenantId").',
      'PROHIBIDO: INSERT/UPDATE/DELETE/DDL, varias sentencias, o columnas de secretos (accessTokenEnc).',
      `NO filtres por tenant (lo aplica la base de datos). Incluye siempre un LIMIT razonable (<= ${MAX_ROWS}).`,
      'ESQUEMA:\n' + schemaChunks.join('\n\n'),
    ].join('\n');
    const out = (await model
      .withStructuredOutput(SqlSchema, { name: 'sql' })
      .invoke([
        { role: 'system', content: system },
        { role: 'user', content: question },
      ])) as z.infer<typeof SqlSchema>;
    return out.sql;
  }

  // Flujo completo. Devuelve el SQL usado y las filas. La validación AST + RLS ocurren en runSelect.
  async run(
    model: BaseChatModel,
    tenantId: string,
    question: string,
  ): Promise<{ sql: string; rows: Record<string, unknown>[] }> {
    if (!this.executor.enabled) {
      throw new Error('Rama B deshabilitada (DATABASE_URL_RO no configurado)');
    }
    const chunks = await this.retrieve(question);
    const sql = await this.generateSql(model, question, chunks);
    const rows = await this.executor.runSelect(tenantId, sql);
    return { sql, rows };
  }
}
