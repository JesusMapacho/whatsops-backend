import { Pool } from 'pg';
import { MAX_ROWS, STATEMENT_TIMEOUT_MS, validateAndCapSql } from './sql-guard';

// Única autoridad que ejecuta SQL del asistente. Conexión con el rol read-only;
// RLS + SET LOCAL app.tenant_id garantizan que no se cruzan tenants aunque el SQL
// omita el filtro. El tenantId viene del JWT (confianza), nunca del LLM.
export class SqlExecutor {
  private pool?: Pool;

  constructor(private readonly connectionString?: string) {}

  get enabled(): boolean {
    return !!this.connectionString;
  }

  private getPool(): Pool {
    if (!this.connectionString) {
      throw new Error('DATABASE_URL_RO no configurado: la Rama B (consulta) está deshabilitada');
    }
    this.pool ??= new Pool({ connectionString: this.connectionString, max: 4 });
    return this.pool;
  }

  // Valida (AST) y ejecuta un SELECT scoped al tenant. Devuelve las filas.
  async runSelect(tenantId: string, sqlRaw: string): Promise<Record<string, unknown>[]> {
    const safeSql = validateAndCapSql(sqlRaw); // lanza UnsafeSqlError si no pasa
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      // set_config parametrizado: el tenantId nunca se interpola en texto SQL.
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const res = await client.query(safeSql);
      await client.query('COMMIT');
      return res.rows.slice(0, MAX_ROWS);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = undefined;
  }
}
