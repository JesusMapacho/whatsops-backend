// Check de las utilidades de conversaciones. Correr: npx ts-node src/messaging/conversations.check.ts
import * as assert from 'node:assert';
import { buildConversationWhere, parseStatus } from './conversations.util';

const T = 'tenant1';
const U = 'user1';

// Admin: los filtros aplican tal cual, siempre acotados por tenant.
assert.deepStrictEqual(buildConversationWhere(T, 'mine', U, 'admin'), {
  tenantId: T,
  assignedUserId: U,
});
assert.deepStrictEqual(buildConversationWhere(T, 'unassigned', U, 'admin'), {
  tenantId: T,
  assignedUserId: null,
});
assert.deepStrictEqual(buildConversationWhere(T, 'open', U, 'admin'), {
  tenantId: T,
  status: 'open',
});
// Filtro desconocido o ausente → solo tenant.
assert.deepStrictEqual(buildConversationWhere(T, undefined, U, 'admin'), { tenantId: T });
assert.deepStrictEqual(buildConversationWhere(T, 'basura', U, 'admin'), { tenantId: T });

// Agente: SIEMPRE limitado a las suyas o abiertas, ignore el filtro que pida.
const agentWhere = { tenantId: T, OR: [{ assignedUserId: U }, { status: 'open' }] };
assert.deepStrictEqual(buildConversationWhere(T, 'unassigned', U, 'agent'), agentWhere);
assert.deepStrictEqual(buildConversationWhere(T, undefined, U, 'agent'), agentWhere);

// parseStatus: acepta el enum, rechaza lo demás.
assert.strictEqual(parseStatus('closed'), 'closed');
assert.strictEqual(parseStatus('open'), 'open');
assert.throws(() => parseStatus('archivado'));
assert.throws(() => parseStatus(123));

console.log('conversations.check OK');
