// Check del aplanado de una respuesta de API (feature 47).
// Correr: npx ts-node src/automations/sondeo.check.ts
//
// Lo que este archivo fija es el VOCABULARIO: las rutas que salen de aquí van al mismo
// autocompletado que las del último run, así que tienen que decidir lo mismo que `aplanar` del
// frontend (`rutas.ts:238-247`). Si los dos se separan, el mismo campo se ofrece de dos formas
// distintas según de dónde salieron las rutas.
import * as assert from 'node:assert';
import { MAX_RUTAS, aplanarRespuesta, tramoAlcanzable } from './sondeo';

const P = 'vars.api.json';
const rutas = (v: unknown) => aplanarRespuesta(v, P).rutas.map((r) => r.ruta);
const una = (v: unknown, ruta: string) => aplanarRespuesta(v, P).rutas.find((r) => r.ruta === ruta);

// --- Solo las hojas, con su tipo -----------------------------------------------------------
{
  const a = aplanarRespuesta({ saldo: 10, cliente: { nombre: 'Ana', activo: true }, nada: null }, P);
  assert.deepStrictEqual(a.rutas.map((r) => r.ruta), [
    'vars.api.json.saldo',
    'vars.api.json.cliente.nombre',
    'vars.api.json.cliente.activo',
    'vars.api.json.nada',
  ]);
  // `cliente` no sale: los tramos intermedios los deriva la pantalla, igual que en `aplanar`.
  assert.strictEqual(una({ cliente: { nombre: 'Ana' } }, 'vars.api.json.cliente'), undefined);
  assert.strictEqual(a.rutas[0].tipo, 'numero');
  assert.strictEqual(a.rutas[1].tipo, 'texto');
  assert.strictEqual(a.rutas[2].tipo, 'booleano');
  assert.strictEqual(a.rutas[3].tipo, 'nulo');
  assert.strictEqual(a.truncado, undefined, 'ausente, NO false: un campo presente dice algo');
}

// --- Los arrays NO se expanden por índice --------------------------------------------------
// Es la regla de `aplanar`, y el motivo no es el scroll: si aquí saliera `data.0.saldo` y del
// último run saliera `data`, el mismo campo tendría dos vocabularios.
{
  const cien = Array.from({ length: 100 }, (_, i) => ({ saldo: i }));
  const a = aplanarRespuesta({ data: cien }, P);
  assert.deepStrictEqual(a.rutas.map((r) => r.ruta), ['vars.api.json.data'], 'una ruta, no cien');
  assert.strictEqual(a.rutas[0].tipo, 'lista');
  assert.strictEqual(a.rutas[0].deLista, true);
  assert.strictEqual(a.rutas[0].ejemplo, '100 elementos');
  assert.strictEqual(aplanarRespuesta({ d: [1] }, P).rutas[0].ejemplo, '1 elemento', 'singular');
}

// --- Alcanzable: la regla es la de los TRAMOS, no la de los NOMBRES ------------------------
// `NOMBRE_VAR` exige empezar por letra; un `0` de índice no vale como nombre de variable y sí
// como tramo de ruta. Usar la regla equivocada marcaría media respuesta con listas como
// inalcanzable.
{
  assert.ok(tramoAlcanzable('saldo'));
  assert.ok(tramoAlcanzable('0'), 'un índice es un tramo válido');
  assert.ok(tramoAlcanzable('_x'));
  assert.ok(!tramoAlcanzable('account-balance'), 'el guion no está en la gramática');
  assert.ok(!tramoAlcanzable('mi campo'));
  assert.ok(!tramoAlcanzable('Content-Type'));
  // Y la cadena de prototipos no es contexto, mismo criterio que `valorDe`.
  assert.ok(!tramoAlcanzable('__proto__'));
  assert.ok(!tramoAlcanzable('constructor'));
}

// --- Una clave inalcanzable viaja MARCADA, y no se baja por ella ---------------------------
// Descartarla haría que el operador viera el campo en la respuesta de su API y no en la lista,
// y concluyera que el sondeo está roto. Ofrecerla sin marcar sería ofrecer una mentira.
{
  const a = aplanarRespuesta({ 'account-balance': { saldo: 10 }, ok: 1 }, P);
  const mala = una({ 'account-balance': { saldo: 10 }, ok: 1 }, 'vars.api.json.account-balance');
  assert.ok(mala, 'la clave mala viaja');
  assert.strictEqual(mala!.alcanzable, false);
  // Y NO se baja: `{{vars.api.json.account-balance.saldo}}` no resuelve por el tramo de en
  // medio, así que ofrecer lo de dentro serían varias mentiras en vez de una.
  assert.ok(!a.rutas.some((r) => r.ruta.includes('account-balance.saldo')));
  // La hermana buena sigue saliendo, y sin marca.
  assert.strictEqual(una({ 'account-balance': 1, ok: 1 }, 'vars.api.json.ok')!.alcanzable, undefined);
}

// --- `truncado` dice CUÁL tope, no que hubo alguno -----------------------------------------
{
  const hondo = { a: { b: { c: { d: { e: 1 } } } } };
  const t = aplanarRespuesta(hondo, P);
  assert.strictEqual(t.truncado, 'profundidad');

  const ancho: Record<string, number> = {};
  for (let i = 0; i < MAX_RUTAS + 50; i++) ancho[`c${i}`] = i;
  const r = aplanarRespuesta(ancho, P);
  assert.strictEqual(r.truncado, 'rutas');
  assert.strictEqual(r.rutas.length, MAX_RUTAS, 'se corta en el tope, no se cuelga');
}

// --- Los tres casos que NO son un error ----------------------------------------------------
// Un `200 {}` es una API que funciona y no tiene nada que nombrar. Que la lista salga vacía no
// puede confundirse con «contestó mal»: eso lo decide `estado`, en el servicio.
{
  assert.deepStrictEqual(rutas({}), [], 'objeto vacío en la raíz: nada que ofrecer');
  assert.deepStrictEqual(rutas([]), [], 'lista vacía en la raíz');
  assert.deepStrictEqual(rutas(42), [], 'un escalar suelto no tiene rutas dentro');
  // Pero un objeto vacío ANIDADO sí es una hoja: el campo existe aunque no tenga nada dentro.
  assert.deepStrictEqual(rutas({ meta: {} }), ['vars.api.json.meta']);
}

// --- El prefijo sale de `guardarComo`, y por eso sondear sin nombre es un 400 ---------------
{
  assert.deepStrictEqual(aplanarRespuesta({ x: 1 }, 'vars.otro.json').rutas[0].ruta, 'vars.otro.json.x');
}

// --- El ejemplo se recorta, que es para reconocer el campo, no para leer el dato ------------
{
  const largo = 'x'.repeat(500);
  const e = una({ nota: largo }, 'vars.api.json.nota')!.ejemplo as string;
  assert.ok(e.length < 300 && e.endsWith('…'));
}

console.log('sondeo.check.ts OK');
