// Check del alcance del CRM. Correr: npx ts-node src/crm/deal-scope.check.ts
import * as assert from 'node:assert';
import { dealScope, dealScopeWhere, taskScope } from './deal-scope';

const T = 'tenant1';
const U = 'user1';
const OTRO = 'user2';

// Admin: sin filtro de filas. El objeto vacío importa — cualquier clave aquí acotaría de
// más y el jefe de ventas dejaría de ver el embudo del equipo.
assert.deepStrictEqual(dealScope('admin', U), {});

// Agente: los suyos y los que no tienen dueño.
assert.deepStrictEqual(dealScope('agent', U), {
  OR: [{ ownerId: U }, { ownerId: null }],
});

// Un trato de otro vendedor no cae en el where del agente. Se comprueba sobre la forma
// del where porque es lo que Prisma va a evaluar: `ownerId: OTRO` no es ninguna de las
// dos ramas del OR.
const rama = dealScope('agent', U) as { OR: Array<{ ownerId: string | null }> };
assert.ok(rama.OR.some((c) => c.ownerId === U), 've los suyos');
assert.ok(
  rama.OR.some((c) => c.ownerId === null),
  've los sin dueño: si no, el alta automática llena un embudo que nadie ve',
);
assert.ok(!rama.OR.some((c) => c.ownerId === OTRO), 'no ve los de otro vendedor');

// El where de un trato concreto siempre lleva tenantId y el alcance encima.
assert.deepStrictEqual(dealScopeWhere(T, 'd1', U, 'agent'), {
  id: 'd1',
  tenantId: T,
  OR: [{ ownerId: U }, { ownerId: null }],
});
// Admin: id + tenant y nada más. El tenantId NUNCA falta, ni siquiera para admin: es el
// único invariante que no se negocia.
assert.deepStrictEqual(dealScopeWhere(T, 'd1', U, 'admin'), { id: 'd1', tenantId: T });

// Las TAREAS no llevan la puerta de "las de nadie": `assignedUserId` no es nulable, así
// que un `{ assignedUserId: null }` aquí no casaría con ninguna fila y solo confundiría.
assert.deepStrictEqual(taskScope('agent', U), { assignedUserId: U });
assert.deepStrictEqual(taskScope('admin', U), {});
const tarea = taskScope('agent', U) as Record<string, unknown>;
assert.ok(!('OR' in tarea), 'el alcance de tareas no es un OR');

console.log('crm/deal-scope.check OK');
