// Check del catálogo de nodos (v3 feature 17). Correr: npx ts-node src/automations/catalog.check.ts
import * as assert from 'node:assert';
import { NODE_TYPES, catalogoPublico, nodeType, validarConfig, validarTrigger } from './catalog';
import { TRIGGERS } from './triggers';

// --- forma del catálogo ---
const keys = NODE_TYPES.map((t) => t.key);
assert.strictEqual(new Set(keys).size, keys.length, 'las keys son únicas');
for (const t of NODE_TYPES) {
  assert.ok(t.label && t.descripcion, `${t.key} tiene label y descripción`);
  assert.ok(['trigger', 'accion', 'logica'].includes(t.category), `${t.key} tiene categoría válida`);
  assert.ok(t.configSchema && typeof t.configSchema === 'object', `${t.key} declara configSchema`);
  // Un trigger no se ejecuta; una acción o lógica sin handler sería un nodo que no hace nada.
  if (t.category === 'trigger') assert.ok(!t.handler, `${t.key} es trigger y no lleva handler`);
  else assert.ok(typeof t.handler === 'function', `${t.key} tiene handler`);
  for (const [campo, def] of Object.entries(t.configSchema)) {
    if (def.tipo === 'opcion') {
      assert.ok(def.opciones?.length, `${t.key}.${campo} de tipo opción declara sus opciones`);
    }
  }
}

// Todo trigger del motor está en el catálogo, y al revés: si divergen, el editor ofrece
// disparadores que nadie escucha (o al contrario).
for (const key of TRIGGERS) {
  assert.strictEqual(nodeType(key)?.category, 'trigger', `${key} está en el catálogo como trigger`);
}
assert.strictEqual(
  NODE_TYPES.filter((t) => t.category === 'trigger').length,
  TRIGGERS.length,
  'no hay triggers en el catálogo que el motor no conozca',
);

// Los nodos que la spec 17 nombra explícitamente, incluido el que sustituye a la vieja 13.
for (const key of ['message.send', 'handoff.human', 'deal.create', 'deal.moveStage', 'deal.setStatus', 'task.create', 'http.request']) {
  assert.ok(nodeType(key), `existe el node type ${key}`);
}

// --- catálogo público: sin handler y serializable (va al navegador) ---
const publico = catalogoPublico();
assert.ok(!publico.some((t: any) => 'handler' in t), 'el catálogo público no lleva handlers');
assert.doesNotThrow(() => JSON.stringify(publico));

// --- validarConfig ---
assert.deepStrictEqual(validarConfig('message.send', { texto: 'hola' }), { texto: 'hola' });
assert.throws(() => validarConfig('message.send', {}), /falta/i, 'campo requerido ausente');
assert.throws(() => validarConfig('message.send', { texto: 42 }), /texto/i, 'tipo equivocado');
assert.throws(() => validarConfig('inventado.nodo', {}), /desconocido/i);
// Lo que no está en el schema se descarta: así un editor viejo no mete basura en la columna.
assert.deepStrictEqual(validarConfig('message.send', { texto: 'hola', colado: 'x' }), { texto: 'hola' });
// Opciones.
assert.deepStrictEqual(validarConfig('conversation.setStatus', { status: 'closed' }), { status: 'closed' });
assert.throws(() => validarConfig('conversation.setStatus', { status: 'archivado' }), /tiene que ser uno de/);
// Números y booleanos llegan como texto desde un formulario.
assert.deepStrictEqual(validarConfig('wait.delay', { minutos: '15' }), { minutos: 15 });
assert.throws(() => validarConfig('wait.delay', { minutos: 'quince' }), /número/);
assert.deepStrictEqual(validarConfig('deal.create', { sinDueno: 'true' }), { sinDueno: true });
// Los opcionales vacíos no se guardan como '' (que luego se lee como «hay valor»).
assert.deepStrictEqual(validarConfig('conversation.assign', { userId: '' }), {});

// --- validarTrigger ---
assert.deepStrictEqual(validarTrigger({ type: 'message.keyword', config: { palabras: ['precio'] } }), {
  type: 'message.keyword',
  config: { palabras: ['precio'] },
});
assert.throws(() => validarTrigger({ type: 'nope' }), /Disparador desconocido/);
assert.throws(() => validarTrigger({ type: 'message.keyword', config: {} }), /falta/i);
assert.deepStrictEqual(validarTrigger({ type: 'manual' }), { type: 'manual', config: {} });

console.log('catalog.check OK');
