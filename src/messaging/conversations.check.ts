// Check de las utilidades de conversaciones. Correr: npx ts-node src/messaging/conversations.check.ts
import * as assert from 'node:assert';
import { buildConversationWhere, parseStatus } from './conversations.util';

const T = 'tenant1';
const U = 'user1';

// Filtros: siempre acotan por tenant.
assert.deepStrictEqual(buildConversationWhere(T, 'mine', U), {
  tenantId: T,
  assignedUserId: U,
});
assert.deepStrictEqual(buildConversationWhere(T, 'unassigned', U), {
  tenantId: T,
  assignedUserId: null,
});
assert.deepStrictEqual(buildConversationWhere(T, 'open', U), {
  tenantId: T,
  status: 'open',
});
// Filtro desconocido o ausente → solo tenant.
assert.deepStrictEqual(buildConversationWhere(T, undefined, U), { tenantId: T });
assert.deepStrictEqual(buildConversationWhere(T, 'basura', U), { tenantId: T });

// parseStatus: acepta el enum, rechaza lo demás.
assert.strictEqual(parseStatus('closed'), 'closed');
assert.strictEqual(parseStatus('open'), 'open');
assert.throws(() => parseStatus('archivado'));
assert.throws(() => parseStatus(123));

console.log('conversations.check OK');
