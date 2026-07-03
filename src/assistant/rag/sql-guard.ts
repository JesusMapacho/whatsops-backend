import { Parser } from 'node-sql-parser';

// SQL generado por LLM = NO CONFIABLE. Este validador por AST es la barrera:
// solo SELECT, una sentencia, tablas en allowlist, y LIMIT forzado.
export const MAX_ROWS = 200;
export const STATEMENT_TIMEOUT_MS = 5000;

// Allowlist de tablas consultables (nombres de tabla Postgres = modelos Prisma).
// Debe coincidir con las tablas con RLS habilitada (assistant-setup.sql) y con el RAG.
export const ALLOWED_TABLES = [
  'Conversation',
  'Message',
  'Contact',
  'Note',
  'Template',
  'CannedResponse',
  'WabaConnection',
].map((t) => t.toLowerCase());

const parser = new Parser();
const OPT = { database: 'postgresql' } as const;

export class UnsafeSqlError extends Error {}

function tableName(entry: string): string {
  // Formato de node-sql-parser: "select::db::Tabla".
  return entry.split('::').pop()!.replace(/"/g, '').toLowerCase();
}

// Valida y devuelve un SQL seguro (con LIMIT garantizado). Lanza UnsafeSqlError si no pasa.
export function validateAndCapSql(sqlRaw: string): string {
  const sql = sqlRaw.trim().replace(/;\s*$/, ''); // quita ';' final para poder anexar LIMIT
  let ast: unknown;
  try {
    ast = parser.astify(sql, OPT);
  } catch (e) {
    throw new UnsafeSqlError(`SQL no parseable: ${(e as Error).message}`);
  }

  // Múltiples sentencias → array. Rechazado.
  if (Array.isArray(ast)) {
    throw new UnsafeSqlError('Se permite una sola sentencia');
  }
  const node = ast as { type?: string; limit?: { value?: Array<{ value?: number }> } };
  if (node.type !== 'select') {
    throw new UnsafeSqlError(`Solo se permite SELECT (recibido: ${node.type ?? 'desconocido'})`);
  }

  // Todas las tablas (incluye JOINs y subconsultas) deben estar en la allowlist.
  const tables = parser.tableList(sql, OPT).map(tableName);
  const bad = tables.filter((t) => !ALLOWED_TABLES.includes(t));
  if (bad.length) {
    throw new UnsafeSqlError(`Tabla(s) fuera de la allowlist: ${bad.join(', ')}`);
  }

  // LIMIT: si falta, se inyecta; si excede el máximo, se rechaza.
  const limitVals = node.limit?.value ?? [];
  if (limitVals.length === 0) {
    return `${sql} LIMIT ${MAX_ROWS}`;
  }
  const requested = limitVals[limitVals.length - 1]?.value ?? MAX_ROWS;
  if (requested > MAX_ROWS) {
    throw new UnsafeSqlError(`LIMIT ${requested} excede el máximo (${MAX_ROWS})`);
  }
  return sql;
}
