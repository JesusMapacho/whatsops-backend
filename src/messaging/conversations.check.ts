// Check de las utilidades de conversaciones. Correr: npx ts-node src/messaging/conversations.check.ts
import * as assert from 'node:assert';
import { buildConversationWhere, parseStatus, shapeConversationRow } from './conversations.util';

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

// Filtro 'frio' = conversaciones que ABRIMOS nosotros y nadie ha contestado.
// `lastInboundAt: null`, NO "fuera de la ventana de 24 h": quien escribió hace tres
// días ya nos conoce y no cuenta como frío.
assert.deepStrictEqual(buildConversationWhere(T, 'frio', U, 'admin'), {
  tenantId: T,
  lastInboundAt: null,
});
// Un agente no lo obtiene aunque lo pida: sigue viendo solo las suyas o abiertas.
assert.deepStrictEqual(buildConversationWhere(T, 'frio', U, 'agent'), agentWhere);

// parseStatus: acepta el enum, rechaza lo demás.
assert.strictEqual(parseStatus('closed'), 'closed');
assert.strictEqual(parseStatus('open'), 'open');
assert.throws(() => parseStatus('archivado'));
assert.throws(() => parseStatus(123));

// shapeConversationRow: el `messages` del include NO puede salir en la respuesta,
// y el último mensaje se publica como `lastMessage`.
const sign = (k: string) => `/media/${k}?firmado`;
const shaped = shapeConversationRow(
  { id: 'c1', status: 'open', messages: [{ id: 'm2' }, { id: 'm1' }] } as any,
  3,
  sign,
) as any;
assert.deepStrictEqual(shaped, {
  id: 'c1',
  status: 'open',
  unread: 3,
  lastMessage: { id: 'm2' },
  contact: undefined,
});
assert.ok(!('messages' in shaped), 'messages no debe viajar al cliente');
// Sin mensajes (conversación recién abierta en frío) es null, no undefined.
assert.strictEqual(shapeConversationRow({ id: 'c2', messages: [] } as any, 0, sign).lastMessage, null);
assert.strictEqual(shapeConversationRow({ id: 'c3' } as any, 0, sign).lastMessage, null);

// La foto del contacto sale como URL firmada, nunca como key cruda para el navegador.
const withPic = shapeConversationRow(
  { id: 'c4', contact: { id: 'k1', name: 'Ana', avatarKey: 'abc' }, messages: [] } as any,
  0,
  sign,
) as any;
assert.strictEqual(withPic.contact.avatarUrl, '/media/abc?firmado');
assert.strictEqual(withPic.contact.name, 'Ana', 'el resto del contacto se conserva');
// Sin foto guardada la clave existe y vale null: el cliente distingue "no hay" de
// "todavía no viene ese campo" y puede caer a las iniciales sin dudar.
const noPic = shapeConversationRow(
  { id: 'c5', contact: { id: 'k2', avatarKey: null }, messages: [] } as any,
  0,
  sign,
) as any;
assert.strictEqual(noPic.contact.avatarUrl, null);

console.log('conversations.check OK');
