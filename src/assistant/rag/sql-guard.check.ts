// Check del validador AST. Correr: npx ts-node src/assistant/rag/sql-guard.check.ts
import * as assert from 'node:assert';
import { validateAndCapSql, UnsafeSqlError, MAX_ROWS } from './sql-guard';

// SELECT válido sobre tabla permitida: pasa y se le inyecta LIMIT si falta.
assert.strictEqual(
  validateAndCapSql('SELECT id FROM "Conversation" WHERE status = \'open\''),
  `SELECT id FROM "Conversation" WHERE status = 'open' LIMIT ${MAX_ROWS}`,
);
// LIMIT presente y dentro del máximo: se respeta.
assert.strictEqual(
  validateAndCapSql('SELECT id FROM "Conversation" LIMIT 10'),
  'SELECT id FROM "Conversation" LIMIT 10',
);
// ';' final no rompe.
assert.ok(validateAndCapSql('SELECT id FROM "Message";').endsWith(`LIMIT ${MAX_ROWS}`));

// JOIN entre tablas permitidas: pasa.
assert.ok(
  validateAndCapSql('SELECT c.id FROM "Conversation" c JOIN "Message" m ON m."conversationId" = c.id'),
);

// ── Rechazos (verificación del spec) ────────────────────────────────────────
const reject = (sql: string) => assert.throws(() => validateAndCapSql(sql), UnsafeSqlError, sql);
reject('DELETE FROM "Conversation"');
reject('UPDATE "Conversation" SET status = \'closed\'');
reject('INSERT INTO "Activity" (body) VALUES (\'x\')');
reject('DROP TABLE "Conversation"');
reject('SELECT 1; DROP TABLE "Conversation"'); // multi-sentencia
reject('SELECT * FROM "User"'); // tabla fuera de allowlist
reject('SELECT * FROM "Conversation" LIMIT 5000'); // LIMIT excesivo
reject('SELECT * FROM pg_catalog.pg_tables'); // introspección fuera de allowlist
// `Note` se absorbió en `Activity` (v8 feature 34): la tabla ya no existe, así que
// tampoco puede estar en la allowlist. Sin esta aserción, alguien que "arregle" el guard
// devolviendo `Note` a la lista no rompería ningún check y el fallo aparecería en
// producción como un error de Postgres desde el ejecutor.
reject('SELECT * FROM "Note"');
// Las tablas puente no tienen `tenantId`, así que la política RLS no puede aplicarles y
// no se exponen. Ver el comentario de ALLOWED_TABLES.
reject('SELECT * FROM "ContactTag"');
// Las del CRM sí, y con JOIN entre ellas (es la consulta del valor del embudo por etapa).
assert.ok(
  validateAndCapSql(
    'SELECT s.name, SUM(d.amount) FROM "Deal" d JOIN "Stage" s ON s.id = d."stageId" GROUP BY s.name',
  ),
);
assert.ok(validateAndCapSql('SELECT count(*) FROM "Task" WHERE "completedAt" IS NULL'));
assert.ok(validateAndCapSql('SELECT body FROM "Activity" WHERE type = \'note\''));

console.log('sql-guard.check OK');
