// Check del enrutado del grafo (v3 features 17-18). Correr: npx ts-node src/automations/graph.check.ts
import * as assert from 'node:assert';
import { nodoRaiz, problemasDelGrafo, siguienteNodoId } from './graph';

const nodos = [
  { id: 'a', type: 'message.send', isRoot: true },
  { id: 'b', type: 'logic.condition', isRoot: false },
  { id: 'c', type: 'message.send', isRoot: false },
  { id: 'd', type: 'message.send', isRoot: false },
];
const aristas = [
  { fromNodeId: 'a', toNodeId: 'b', branch: null },
  { fromNodeId: 'b', toNodeId: 'c', branch: 'true' },
  { fromNodeId: 'b', toNodeId: 'd', branch: 'false' },
];

// --- raíz ---
assert.strictEqual(nodoRaiz(nodos)?.id, 'a');
assert.strictEqual(nodoRaiz([]), null);

// --- siguiente ---
assert.strictEqual(siguienteNodoId(aristas, 'a'), 'b', 'acción → su única salida');
assert.strictEqual(siguienteNodoId(aristas, 'b', 'true'), 'c');
assert.strictEqual(siguienteNodoId(aristas, 'b', 'false'), 'd');
assert.strictEqual(siguienteNodoId(aristas, 'c'), null, 'sin salida → el run termina');
// Rama que no existe cae en la salida por defecto…
assert.strictEqual(siguienteNodoId([...aristas, { fromNodeId: 'b', toNodeId: 'a', branch: null }], 'b', 'otra'), 'a');
// …y si tampoco hay salida por defecto, el run termina (el caso «solo si» de logic.filter).
assert.strictEqual(siguienteNodoId(aristas, 'b', 'stop'), null);

// --- validación al activar ---
assert.deepStrictEqual(problemasDelGrafo(nodos, aristas), [], 'un grafo sano no tiene quejas');
assert.match(problemasDelGrafo([], [])[0], /ni un nodo/);
assert.ok(
  problemasDelGrafo(nodos.map((n) => ({ ...n, isRoot: false })), aristas).some((p) => /empieza/.test(p)),
  'sin raíz se avisa',
);
assert.ok(
  problemasDelGrafo(nodos.map((n) => ({ ...n, isRoot: true })), aristas).some((p) => /más de un nodo de inicio/.test(p)),
);
assert.ok(
  problemasDelGrafo(nodos, [...aristas, { fromNodeId: 'a', toNodeId: 'zzz', branch: 'x' }]).some((p) =>
    /no está en este grafo/.test(p),
  ),
);
// Bucle: lo impide la unique (runId, nodeId) del log de pasos, así que se detecta al activar.
assert.ok(
  problemasDelGrafo(nodos, [...aristas, { fromNodeId: 'c', toNodeId: 'a', branch: null }]).some((p) =>
    /bucle/.test(p),
  ),
);
// Nodo suelto.
assert.ok(
  problemasDelGrafo([...nodos, { id: 'e', type: 'message.send', isRoot: false }], aristas).some((p) =>
    /no se alcanzan/.test(p),
  ),
);

console.log('graph.check OK');
