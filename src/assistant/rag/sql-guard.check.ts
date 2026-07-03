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
reject('INSERT INTO "Note" (body) VALUES (\'x\')');
reject('DROP TABLE "Conversation"');
reject('SELECT 1; DROP TABLE "Conversation"'); // multi-sentencia
reject('SELECT * FROM "User"'); // tabla fuera de allowlist
reject('SELECT * FROM "Conversation" LIMIT 5000'); // LIMIT excesivo
reject('SELECT * FROM pg_catalog.pg_tables'); // introspección fuera de allowlist

console.log('sql-guard.check OK');
