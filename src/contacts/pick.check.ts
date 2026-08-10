// Check de la selección de miembros. Correr: npx ts-node src/contacts/pick.check.ts
import * as assert from 'node:assert';
import { normalizeIds, pickSelected } from './pick';

const miembros = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

// Sin selección = todos. Es lo que espera quien solo elige una cartera.
assert.deepStrictEqual(pickSelected(miembros, undefined), miembros);
assert.deepStrictEqual(pickSelected(miembros, []), miembros);
assert.deepStrictEqual(pickSelected(miembros, ''), miembros);

// Con selección, solo esos y en el orden pedido.
assert.deepStrictEqual(pickSelected(miembros, ['c', 'a']), [{ id: 'c' }, { id: 'a' }]);
// Un solo id como string (multipart con un único valor) NO es "ninguno". Sin normalizar,
// seleccionar una persona se leería como toda la cartera — el peor fallo posible aquí.
assert.deepStrictEqual(pickSelected(miembros, 'b'), [{ id: 'b' }]);
// Repetidos colapsan: publicar dos veces al mismo no hace nada e infla el recuento.
assert.deepStrictEqual(pickSelected(miembros, ['a', 'a']), [{ id: 'a' }]);

// LA ASERCIÓN DE SEGURIDAD: un id que NO es miembro se RECHAZA. Sin esto, `contactIds`
// sería una forma de escribirle a cualquier contacto del tenant pasando por encima de la
// regla de la cartera, que es justo el agujero que la cartera existe para cerrar.
assert.throws(() => pickSelected(miembros, ['a', 'z']), /no están en esa cartera/);
assert.throws(() => pickSelected(miembros, ['z']));
// Y no se ignora en silencio: ignorarlo dejaría al operador creyendo que envió a alguien
// a quien no envió.
assert.throws(() => pickSelected([], ['a']));

// normalizeIds por separado.
assert.deepStrictEqual(normalizeIds(['x', 'y']), ['x', 'y']);
assert.deepStrictEqual(normalizeIds('x'), ['x']);
assert.deepStrictEqual(normalizeIds('  '), []);
assert.deepStrictEqual(normalizeIds(null), []);
assert.deepStrictEqual(normalizeIds(['x', '']), ['x']);

console.log('pick.check OK');
