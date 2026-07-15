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

// Búsqueda/assignedUserId: se cuelgan como AND, sin tocar el scope base.
const searched = buildConversationWhere(T, 'open', U, 'admin', 'Juan') as any;
assert.strictEqual(searched.tenantId, T);
assert.strictEqual(searched.status, 'open');
assert.strictEqual(searched.AND.length, 1);
assert.ok(searched.AND[0].OR.some((c: any) => c.contact?.name?.contains === 'Juan'));
// Agente: el scope suyas/abiertas se conserva aunque haya q.
const agentSearched = buildConversationWhere(T, undefined, U, 'agent', 'hola') as any;
assert.deepStrictEqual(agentSearched.OR, [{ assignedUserId: U }, { status: 'open' }]);
assert.strictEqual(agentSearched.AND.length, 1);
// assignedUserId sin q → un solo AND.
const byAgent = buildConversationWhere(T, undefined, U, 'admin', undefined, 'u9') as any;
assert.deepStrictEqual(byAgent.AND, [{ assignedUserId: 'u9' }]);
// q en blanco no agrega AND.
assert.deepStrictEqual(buildConversationWhere(T, 'open', U, 'admin', '  '), {
  tenantId: T,
  status: 'open',
});

// parseStatus: acepta el enum, rechaza lo demás.
assert.strictEqual(parseStatus('closed'), 'closed');
assert.strictEqual(parseStatus('open'), 'open');
assert.throws(() => parseStatus('archivado'));
assert.throws(() => parseStatus(123));

console.log('conversations.check OK');
