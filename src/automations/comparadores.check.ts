// Check de los comparadores (v3 feature 18). Correr: npx ts-node src/automations/comparadores.check.ts
import * as assert from 'node:assert';
import { comparar, ramaDeCondicion, ramaDeSwitch } from './comparadores';

// --- eq / neq: sin distinguir mayúsculas ni acentos ---
assert.ok(comparar('eq', 'Sí', 'si'), 'acentos y mayúsculas no deciden una venta');
assert.ok(comparar('eq', '  hola ', 'hola'), 'recorta espacios');
assert.ok(!comparar('eq', 'hola', 'adios'));
assert.ok(comparar('neq', 'hola', 'adios'));

// --- contains ---
assert.ok(comparar('contains', 'quiero el PRECIO ya', 'precio'));
assert.ok(!comparar('contains', 'quiero info', 'precio'));

// --- gt / lt: numéricos de verdad ---
assert.ok(comparar('gt', 10, 5));
assert.ok(comparar('gt', '10', 5), 'texto numérico cuenta');
assert.ok(!comparar('gt', 5, 10));
assert.ok(comparar('lt', 5, 10));
// El caso que motiva `numero()`: vacío/ausente NO es cero.
assert.ok(!comparar('gt', '', 0), 'vacío no supera a 0');
assert.ok(!comparar('gt', undefined, 0), 'ausente no supera a 0');
assert.ok(!comparar('gt', 'hola', 5), 'texto no numérico no compara');

// --- matches ---
assert.ok(comparar('matches', 'pedido 1234', '^pedido \\d+$'));
assert.ok(comparar('matches', 'PEDIDO 1', '^pedido'), 'la regex va sin distinguir mayúsculas');
assert.ok(!comparar('matches', 'abc', '\\d+'));
// Una regex inválida la escribió una persona: no coincide y no tumba el run.
assert.doesNotThrow(() => comparar('matches', 'abc', '('));
assert.ok(!comparar('matches', 'abc', '('));

// --- ramaDeCondicion ---
const ctx = { mensaje: { texto: 'quiero precio' }, deal: { amount: 1500 } };
assert.strictEqual(ramaDeCondicion({ campo: 'mensaje.texto', operador: 'contains', valor: 'precio' }, ctx), 'true');
assert.strictEqual(ramaDeCondicion({ campo: 'mensaje.texto', operador: 'contains', valor: 'baja' }, ctx), 'false');
assert.strictEqual(ramaDeCondicion({ campo: 'deal.amount', operador: 'gt', valor: 1000 }, ctx), 'true');
// Campo ausente → false, y sin lanzar.
assert.strictEqual(ramaDeCondicion({ campo: 'no.existe', operador: 'eq', valor: 'x' }, ctx), 'false');
// Config a medias (operador inválido) cae en `eq` en vez de reventar.
assert.strictEqual(ramaDeCondicion({ campo: 'mensaje.texto', operador: 'raro', valor: 'quiero precio' }, ctx), 'true');

// --- ramaDeSwitch ---
const casos = [
  { rama: 'vip', operador: 'gt', valor: 1000 },
  { rama: 'normal', operador: 'gt', valor: 0 },
];
assert.strictEqual(ramaDeSwitch({ campo: 'deal.amount', casos }, ctx), 'vip', 'gana el primero que coincide');
assert.strictEqual(ramaDeSwitch({ campo: 'deal.amount', casos }, { deal: { amount: 10 } }), 'normal');
assert.strictEqual(ramaDeSwitch({ campo: 'deal.amount', casos }, { deal: { amount: 0 } }), null, 'ninguno → salida por defecto');
assert.strictEqual(ramaDeSwitch({ campo: 'deal.amount', casos: 'no es lista' }, ctx), null);

// --- El «Campo» admite tuberías (v10 feature 40) ---
//
// El campo de un nodo de lógica es una ruta cruda, sin llaves, pero pasa por el mismo
// lenguajito. Sin esto, «si la lista tiene más de tres» obliga a meter un `code.run` —un
// proceso hijo— para contar elementos.
const conLista = { vars: { lista: ['a', 'b', 'c', 'd'], nombre: 'Ana', vacio: null } };
assert.strictEqual(
  ramaDeCondicion({ campo: 'vars.lista | cuenta', operador: 'gt', valor: 3 }, conLista),
  'true',
  'cuatro elementos son más de tres',
);
assert.strictEqual(
  ramaDeCondicion({ campo: 'vars.lista | cuenta', operador: 'gt', valor: 4 }, conLista),
  'false',
);
assert.strictEqual(
  ramaDeCondicion({ campo: 'vars.nombre | mayus', operador: 'eq', valor: 'ANA' }, conLista),
  'true',
);
assert.strictEqual(
  ramaDeCondicion({ campo: 'vars.vacio | por_defecto:"nada"', operador: 'eq', valor: 'nada' }, conLista),
  'true',
  '`por_defecto` también sirve para comparar lo que falta',
);
assert.strictEqual(
  ramaDeCondicion({ campo: 'vars.lista', operador: 'eq', valor: 'x' }, conLista),
  'false',
  'una ruta pelada sigue funcionando igual que antes: no rompe nada guardado',
);
assert.strictEqual(
  ramaDeCondicion({ campo: "vars.lista.join(', ')", operador: 'eq', valor: 'a, b, c, d' }, conLista),
  'false',
  'la sintaxis de JS no parsea aquí tampoco: se cae a ruta pelada, que no resuelve',
);
assert.strictEqual(
  ramaDeSwitch(
    { campo: 'vars.lista | cuenta', casos: [{ rama: 'muchos', operador: 'gt', valor: 2 }] },
    conLista,
  ),
  'muchos',
  'y en el switch igual',
);

console.log('comparadores.check OK');
