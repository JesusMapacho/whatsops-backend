// Check de las etapas del embudo. Correr: npx ts-node src/crm/stages.check.ts
import * as assert from 'node:assert';
import {
  ETAPAS_INICIALES,
  StagesError,
  ordenar,
  primeraEtapa,
  puedeBorrar,
  reordenar,
} from './stages';

const e = (id: string, name: string, position: number) => ({ id, name, position });

// --- ordenar --------------------------------------------------------------------------
assert.deepStrictEqual(
  ordenar([e('c', 'C', 2), e('a', 'A', 0), e('b', 'B', 1)]).map((x) => x.id),
  ['a', 'b', 'c'],
);
// Desempate estable por nombre cuando dos comparten position (puede pasar: no hay unique).
assert.deepStrictEqual(
  ordenar([e('z', 'Zeta', 1), e('a', 'Alfa', 1)]).map((x) => x.id),
  ['a', 'z'],
);
// No muta la entrada.
const entrada = [e('b', 'B', 1), e('a', 'A', 0)];
ordenar(entrada);
assert.strictEqual(entrada[0].id, 'b');

// --- reordenar ------------------------------------------------------------------------
const existentes = ['a', 'b', 'c'];
// Mover la última al principio: posiciones 0..n-1 sin huecos y SIN dos etapas empatadas,
// que es el fallo que un unique en (pipelineId, position) haría imposible de arreglar.
const movida = reordenar(['c', 'a', 'b'], existentes);
assert.deepStrictEqual(movida, [
  { id: 'c', position: 0 },
  { id: 'a', position: 1 },
  { id: 'b', position: 2 },
]);
assert.strictEqual(new Set(movida.map((m) => m.position)).size, 3, 'ninguna posición repetida');
assert.deepStrictEqual(
  movida.map((m) => m.position).sort((x, y) => x - y),
  [0, 1, 2],
  'sin huecos',
);
// Reordenar al mismo orden es válido (la UI puede mandarlo).
assert.deepStrictEqual(reordenar(existentes, existentes).map((m) => m.position), [0, 1, 2]);

// Un id repetido se rechaza: colapsaría dos etapas en una posición y perdería la otra.
assert.throws(() => reordenar(['a', 'a', 'b'], existentes), StagesError);
// Una lista incompleta se rechaza: la que falta se quedaría con su posición vieja y
// aparecería donde nadie pidió.
assert.throws(() => reordenar(['a', 'b'], existentes), StagesError);
// Un id ajeno se rechaza: sería mover la etapa de otra pipeline (o de otro tenant) desde
// el cuerpo de la petición.
assert.throws(() => reordenar(['a', 'b', 'x'], existentes), StagesError);

// --- puedeBorrar ----------------------------------------------------------------------
// Sin tratos: se borra sin decir nada.
assert.deepStrictEqual(
  puedeBorrar({ stageId: 'b', etapasDeLaPipeline: existentes, tratosAbiertos: 0 }),
  {},
);
// Con tratos y sin destino: se rechaza. Es el freno que evita el borrado en cascada.
assert.throws(
  () => puedeBorrar({ stageId: 'b', etapasDeLaPipeline: existentes, tratosAbiertos: 3 }),
  StagesError,
);
// Con tratos y destino válido: pasa y devuelve el destino.
assert.deepStrictEqual(
  puedeBorrar({
    stageId: 'b',
    etapasDeLaPipeline: existentes,
    tratosAbiertos: 3,
    moveToStageId: 'a',
  }),
  { moveToStageId: 'a' },
);
// Destino = la etapa que se borra: sería perder los tratos.
assert.throws(
  () =>
    puedeBorrar({
      stageId: 'b',
      etapasDeLaPipeline: existentes,
      tratosAbiertos: 1,
      moveToStageId: 'b',
    }),
  StagesError,
);
// Destino de otra pipeline: dejaría pipelineId y stageId contando cosas distintas.
assert.throws(
  () =>
    puedeBorrar({
      stageId: 'b',
      etapasDeLaPipeline: existentes,
      tratosAbiertos: 1,
      moveToStageId: 'ajena',
    }),
  StagesError,
);
// La última etapa no se borra ni estando vacía: una pipeline sin etapas no admite tratos.
assert.throws(
  () => puedeBorrar({ stageId: 'a', etapasDeLaPipeline: ['a'], tratosAbiertos: 0 }),
  StagesError,
);
// Una etapa que no es de la pipeline no se borra por aquí.
assert.throws(
  () => puedeBorrar({ stageId: 'ajena', etapasDeLaPipeline: existentes, tratosAbiertos: 0 }),
  StagesError,
);

// --- primeraEtapa ---------------------------------------------------------------------
// Es por POSITION, no por orden de llegada del array: ahí caen los tratos nuevos y los
// que crea la regla de alta automática.
assert.strictEqual(primeraEtapa([e('c', 'C', 2), e('a', 'A', 0)]).id, 'a');
assert.throws(() => primeraEtapa([]), StagesError);

// El semillero arranca con cuatro etapas y la primera es la de entrada al embudo.
assert.strictEqual(ETAPAS_INICIALES.length, 4);
assert.strictEqual(ETAPAS_INICIALES[0], 'Nuevo prospecto');

console.log('crm/stages.check OK');
