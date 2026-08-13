import { Parser } from 'node-sql-parser';

// SQL generado por LLM = NO CONFIABLE. Este validador por AST es la barrera:
// solo SELECT, una sentencia, tablas en allowlist, y LIMIT forzado.
export const MAX_ROWS = 200;
export const STATEMENT_TIMEOUT_MS = 5000;

// Allowlist de tablas consultables (nombres de tabla Postgres = modelos Prisma).
// Debe coincidir con las tablas con RLS habilitada (assistant-setup.sql) y con el RAG.
//
// Requisito para entrar aquí: tener columna `tenantId`. La política RLS es
// `tenantId = current_setting('app.tenant_id')`, así que una tabla sin esa columna no
// puede aislarse por tenant y no se expone. Por eso quedan fuera las tablas puente
// (`ContactTag`, `ContactListMember`, `ContactListRole`): el precio es que el asistente
// no sabe contestar "cuántos contactos tienen la etiqueta VIP". Camino de upgrade el día
// que alguien lo pida: desnormalizar `tenantId` en la puente, como ya se hace en `Stage`.
export const ALLOWED_TABLES = [
  'Conversation',
  'Message',
  'Contact',
  // `Note` se absorbió en `Activity` (v8 feature 34). Si esta lista siguiera diciendo
  // `Note`, el LLM generaría `SELECT ... FROM "Note"` —la tabla ya no existe— y el
  // error saldría del ejecutor en vez del guard.
  'Activity',
  'Deal',
  'Task',
  'Pipeline',
  'Stage',
  'Tag',
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
