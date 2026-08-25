// Check del grafo de llamadas entre automatizaciones (feature 43).
// Correr: npx ts-node src/automations/llamadas.check.ts
//
// Es la guarda que se comprueba AL ACTIVAR. La otra —la de ejecución— vive en `subflujo.ts` y
// tiene su propio check: las dos hacen falta, porque esta se queda vieja (dos admins activando
// a la vez ven cada uno un mundo sin el otro) y porque un grafo de llamadas legal no es un
// grafo de llamadas sano.
import * as assert from 'node:assert';
import { FlujoConocido, MAX_PROFUNDIDAD, idsLlamados, problemasDeLlamadas } from './llamadas';
import { TIPO_LLAMADA } from './catalog';

const flujo = (nombre: string, llama: string[] = [], extra: Partial<FlujoConocido> = {}): FlujoConocido => ({
  nombre,
  status: 'active',
  llama,
  espera: false,
  ...extra,
});

const mapa = (o: Record<string, FlujoConocido>) => new Map(Object.entries(o));
const hay = (msgs: string[], trozo: string) => msgs.some((m) => m.includes(trozo));

// --- idsLlamados: solo mira el nodo de llamada -------------------------------------------
{
  assert.deepStrictEqual(
    idsLlamados([
      { type: 'message.send', config: { texto: 'hola' } },
      { type: TIPO_LLAMADA, config: { automationId: 'b' } },
      { type: 'deal.create', config: {} },
      { type: TIPO_LLAMADA, config: { automationId: 'c' } },
    ]),
    ['b', 'c'],
  );
  // Sin repetidos: llamar dos veces al mismo flujo es legal y para decidir da igual.
  assert.deepStrictEqual(
    idsLlamados([
      { type: TIPO_LLAMADA, config: { automationId: 'b' } },
      { type: TIPO_LLAMADA, config: { automationId: 'b' } },
    ]),
    ['b'],
  );
  // Un nodo de llamada a medio configurar no es una llamada.
  assert.deepStrictEqual(idsLlamados([{ type: TIPO_LLAMADA, config: {} }]), []);
  assert.deepStrictEqual(idsLlamados([{ type: TIPO_LLAMADA, config: null }]), []);
  assert.deepStrictEqual(idsLlamados([]), []);
}

// --- Un grafo de llamadas sano no dice nada ----------------------------------------------
{
  const f = mapa({ b: flujo('Bienvenida'), c: flujo('Cierre') });
  assert.deepStrictEqual(problemasDeLlamadas('a', ['b', 'c'], f), []);
  assert.deepStrictEqual(problemasDeLlamadas('a', [], f), [], 'no llamar a nadie tampoco es un problema');
}

// --- Auto-llamada -------------------------------------------------------------------------
{
  const p = problemasDeLlamadas('a', ['a'], mapa({ a: flujo('A', ['a']) }));
  assert.ok(hay(p, 'se llama a sí misma'), p.join(' | '));
}

// --- A → B → A, y detectado desde LOS DOS lados -------------------------------------------
// Cada activación es la única oportunidad de pararlo desde ese lado: si solo se detectara al
// activar A, activar B primero dejaría el bucle montado.
{
  const f = mapa({ a: flujo('A', ['b']), b: flujo('B', ['a']) });
  const desdeA = problemasDeLlamadas('a', ['b'], f);
  assert.ok(hay(desdeA, 'bucle de llamadas'), desdeA.join(' | '));
  // El mensaje nombra el camino con NOMBRES, no con cuids: el operador no conoce los ids.
  assert.ok(hay(desdeA, 'A → B → A'), desdeA.join(' | '));

  const desdeB = problemasDeLlamadas('b', ['a'], f);
  assert.ok(hay(desdeB, 'bucle de llamadas'), desdeB.join(' | '));
}

// --- Ciclo largo: A → B → C → A -----------------------------------------------------------
{
  const f = mapa({ a: flujo('A', ['b']), b: flujo('B', ['c']), c: flujo('C', ['a']) });
  const p = problemasDeLlamadas('a', ['b'], f);
  assert.ok(hay(p, 'A → B → C → A'), p.join(' | '));
}

// --- Un ciclo que NO pasa por mí no me impide activarme -----------------------------------
// B y C se llaman entre ellas: es problema de la activación de B y de la de C, no de la de A.
// Y sobre todo: no puede colgar la búsqueda.
{
  const f = mapa({ b: flujo('B', ['c']), c: flujo('C', ['b']) });
  const p = problemasDeLlamadas('a', ['b'], f);
  assert.ok(!hay(p, 'bucle de llamadas'), p.join(' | '));
}

// --- Profundidad: acíclico y aun así demasiado hondo --------------------------------------
// Es un problema DISTINTO del ciclo y tiene su propio mensaje. A → B → C → D son 3 niveles
// bajo A, que es el máximo; añadir E lo pasa.
{
  const sano = mapa({ b: flujo('B', ['c']), c: flujo('C', ['d']), d: flujo('D') });
  assert.deepStrictEqual(problemasDeLlamadas('a', ['b'], sano), [], `${MAX_PROFUNDIDAD} niveles caben`);

  const hondo = mapa({ b: flujo('B', ['c']), c: flujo('C', ['d']), d: flujo('D', ['e']), e: flujo('E') });
  const p = problemasDeLlamadas('a', ['b'], hondo);
  assert.ok(hay(p, 'baja 4 niveles'), p.join(' | '));
  assert.ok(!hay(p, 'bucle'), 'hondo no es lo mismo que cíclico');
}

// --- Llamar a algo que no está en el mapa -------------------------------------------------
// El mapa lo arma el servicio con `where: { tenantId }`, así que «no existe» y «es de otro
// negocio» llegan aquí igual — y tienen que decir lo mismo: decir «existe pero no es tuya»
// sería filtrar que existe.
{
  const p = problemasDeLlamadas('a', ['fantasma'], mapa({}));
  assert.ok(hay(p, 'ya no existe'), p.join(' | '));
  assert.ok(!hay(p, 'fantasma'), 'no se escupe el id en el mensaje');
}

// --- Llamar a un borrador ------------------------------------------------------------------
{
  const p = problemasDeLlamadas('a', ['b'], mapa({ b: flujo('Bienvenida', [], { status: 'draft' }) }));
  assert.ok(hay(p, 'está en borrador'), p.join(' | '));
  assert.ok(hay(p, 'Bienvenida'), 'con su nombre, para poder ir a activarla');
}

// --- Llamar a un flujo que espera ---------------------------------------------------------
// Un sub-flujo es un procedimiento, no una conversación: la llamada es síncrona dentro del paso
// del padre y no hay forma de aparcarla.
{
  const p = problemasDeLlamadas('a', ['b'], mapa({ b: flujo('Encuesta', [], { espera: true }) }));
  assert.ok(hay(p, 'nodo de espera'), p.join(' | '));
  assert.ok(hay(p, 'Encuesta'));
}

// --- Varios problemas a la vez salen todos ------------------------------------------------
// El servicio los concatena en un solo `BadRequestException`: enseñar uno y esconder el resto
// obliga al operador a activar cuatro veces para enterarse de cuatro cosas.
{
  const f = mapa({ b: flujo('B', [], { status: 'draft', espera: true }), c: flujo('C', ['a']) });
  const p = problemasDeLlamadas('a', ['a', 'b', 'c'], f);
  assert.ok(hay(p, 'se llama a sí misma') && hay(p, 'borrador') && hay(p, 'espera') && hay(p, 'bucle'), p.join(' | '));
}

console.log('llamadas.check.ts OK');
