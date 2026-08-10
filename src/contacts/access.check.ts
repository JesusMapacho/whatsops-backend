// Check del acceso a carteras. Correr: npx ts-node src/contacts/access.check.ts
import * as assert from 'node:assert';
import { canManageList, canUseList, ListRoleLink, usableListIds } from './access';

const admin = { role: 'admin', roleId: null };
const ventas = { role: 'agent', roleId: 'rol_ventas' };
const soporte = { role: 'agent', roleId: 'rol_soporte' };
const sinRol = { role: 'agent', roleId: null };

const links: ListRoleLink[] = [
  // "Clientes VIP": ventas la usa y la gestiona.
  { contactListId: 'vip', roleId: 'rol_ventas', canManage: true },
  // "Todos": ventas y soporte la usan, ninguno la gestiona.
  { contactListId: 'todos', roleId: 'rol_ventas', canManage: false },
  { contactListId: 'todos', roleId: 'rol_soporte', canManage: false },
];

// LA ASERCIÓN QUE MÁS IMPORTA: una cartera sin NINGÚN enlace es solo de admin. El
// default es cerrado a propósito — una cartera recién creada no debe quedar expuesta al
// tenant entero antes de que su dueño decida con quién compartirla.
assert.strictEqual(canUseList(ventas, 'privada', links), false);
assert.strictEqual(canUseList(soporte, 'privada', links), false);
assert.strictEqual(canUseList(admin, 'privada', links), true);

// Usar vs gestionar son cosas distintas: soporte usa "todos" pero no la toca.
assert.strictEqual(canUseList(soporte, 'todos', links), true);
assert.strictEqual(canManageList(soporte, 'todos', links), false);
// Ventas gestiona "vip" porque su enlace lo dice.
assert.strictEqual(canUseList(ventas, 'vip', links), true);
assert.strictEqual(canManageList(ventas, 'vip', links), true);
// Y no puede gestionar "todos", donde su enlace es canManage: false.
assert.strictEqual(canManageList(ventas, 'todos', links), false);

// Un rol NO enlazado no ve la cartera de otro rol.
assert.strictEqual(canUseList(soporte, 'vip', links), false);
assert.strictEqual(canManageList(soporte, 'vip', links), false);

// El admin de sistema pasa por encima de los enlaces. Tiene que coincidir con
// `PermissionsGuard.canActivate`, que también deja pasar a `role === 'admin'`: si no,
// el admin vería el botón y recibiría un 403 al pulsarlo.
assert.strictEqual(canUseList(admin, 'vip', links), true);
assert.strictEqual(canManageList(admin, 'todos', links), true);
assert.deepStrictEqual([...usableListIds(admin, links)].sort(), ['todos', 'vip']);

// Un usuario sin rol a medida (token viejo, o nunca asignado) no accede a nada. Un
// `roleId` nulo NO debe casar con un `roleId` nulo de un enlace.
assert.strictEqual(canUseList(sinRol, 'todos', links), false);
assert.deepStrictEqual([...usableListIds(sinRol, links)], []);
assert.strictEqual(
  canUseList({ role: 'agent', roleId: null }, 'x', [
    { contactListId: 'x', roleId: null as any, canManage: true },
  ]),
  false,
);

// usableListIds: solo las del propio rol, sin duplicar cuando hay varios enlaces.
assert.deepStrictEqual([...usableListIds(ventas, links)].sort(), ['todos', 'vip']);
assert.deepStrictEqual([...usableListIds(soporte, links)], ['todos']);

// Esta función NO decide sobre tenants: los enlaces llegan ya acotados por la query.
// La aserción existe para que quien la cambie sepa dónde está la frontera de tenant.
assert.deepStrictEqual([...usableListIds(ventas, [])], []);

console.log('access.check OK');
