// Check de la consulta y las mutaciones de tratos. Correr: npx ts-node src/crm/deals.query.check.ts
import * as assert from 'node:assert';
import {
  DealError,
  buildDealWhere,
  parseCierre,
  parseDealFilters,
  parseDealPatch,
  parseImporte,
  tituloPorDefecto,
} from './deals.query';

const T = 'tenant1';
const U = 'user1';
const AHORA = new Date('2026-08-13T20:00:00Z');

// --- buildDealWhere -------------------------------------------------------------------
// Por defecto SOLO abiertos: el tablero pinta etapas, y ganado/perdido no está en ninguna.
const base = buildDealWhere(T, {}, U, 'admin') as any;
assert.strictEqual(base.tenantId, T);
assert.strictEqual(base.status, 'open');

// El alcance del agente viaja siempre.
const soloScope = buildDealWhere(T, {}, U, 'agent') as any;
assert.deepStrictEqual(soloScope.OR, [{ ownerId: U }, { ownerId: null }]);
assert.deepStrictEqual(buildDealWhere(T, {}, U, 'admin').OR, undefined, 'admin sin filtro');

// EL CASO QUE IMPORTA: buscar texto NO puede pisar el alcance. `dealScope` usa `OR`, así
// que si la búsqueda asignara `where.OR` un agente vería los tratos de todo el negocio.
// El texto va en `AND` y las dos condiciones conviven.
const agente = buildDealWhere(T, { q: 'paneles' }, U, 'agent') as any;
assert.deepStrictEqual(agente.OR, [{ ownerId: U }, { ownerId: null }], 'el scope sobrevive');
assert.strictEqual(agente.AND.length, 1, 'el texto va en AND');
assert.strictEqual(agente.AND[0].OR.length, 3, 'busca en título, nombre y empresa');
assert.ok(agente.AND[0].OR.some((c: any) => c.title?.contains === 'paneles'));
// Y con todos los filtros juntos el scope sigue intacto.
const todo = buildDealWhere(T, { q: 'x', tagId: 'tg1', pipelineId: 'p1' }, U, 'agent') as any;
assert.deepStrictEqual(todo.OR, [{ ownerId: U }, { ownerId: null }]);
assert.strictEqual(todo.pipelineId, 'p1');

// 'ninguno' = los que nadie ha reclamado, que es la cola de trabajo del equipo.
assert.strictEqual(buildDealWhere(T, { ownerId: 'ninguno' }, U, 'admin').ownerId, null);
assert.strictEqual(buildDealWhere(T, { ownerId: 'u9' }, U, 'admin').ownerId, 'u9');
// Etiqueta: se filtra por la del CONTACTO, que es donde viven.
assert.deepStrictEqual(buildDealWhere(T, { tagId: 'tg1' }, U, 'admin').contact, {
  tags: { some: { tagId: 'tg1' } },
});
assert.strictEqual(buildDealWhere(T, { status: 'won' }, U, 'admin').status, 'won');

// --- parseDealFilters -----------------------------------------------------------------
assert.strictEqual(parseDealFilters({}).status, 'open', 'sin status pide abiertos');
assert.strictEqual(parseDealFilters({ status: 'todos' }).status, undefined, 'todos = sin filtro');
assert.strictEqual(parseDealFilters({ status: 'won' }).status, 'won');
// Un status mal escrito devuelve el tablero, no un 400.
assert.strictEqual(parseDealFilters({ status: 'basura' }).status, 'open');
assert.strictEqual(parseDealFilters({ q: '  paneles ' }).q, 'paneles');

// --- parseImporte ---------------------------------------------------------------------
// Se devuelve TEXTO para que Prisma lo meta en el Decimal sin pasar por un number.
assert.strictEqual(parseImporte('3000'), '3000');
assert.strictEqual(parseImporte('3000.50'), '3000.50');
assert.strictEqual(typeof parseImporte(3000), 'string');
assert.strictEqual(parseImporte(3000), '3000.00');
// Coma decimal: el teclado latino la escribe.
assert.strictEqual(parseImporte('3000,50'), '3000.50');
// Los dos separadores: el ÚLTIMO es el decimal, el otro son miles. Las dos notaciones.
assert.strictEqual(parseImporte('3.000,50'), '3000.50');
assert.strictEqual(parseImporte('3,000.50'), '3000.50');
assert.strictEqual(parseImporte('1.234.567,89'), '1234567.89');
// Separador repetido: solo puede ser de miles.
assert.strictEqual(parseImporte('1.234.567'), '1234567');
assert.strictEqual(parseImporte('1,234,567'), '1234567');
// Símbolo de moneda pegado.
assert.strictEqual(parseImporte('$3000'), '3000');
assert.strictEqual(parseImporte('  $ 3,50 '), '3.50');
// Vacío = sin monto (nadie lo sabe todavía al crear el trato).
assert.strictEqual(parseImporte(''), null);
assert.strictEqual(parseImporte(null), null);
assert.strictEqual(parseImporte(undefined), null);
// Negativo no: un trato no resta.
assert.throws(() => parseImporte('-100'), DealError);
assert.throws(() => parseImporte(-100), DealError);

// EL CASO PELIGROSO: un separador suelto con exactamente tres cifras detrás es ambiguo
// —`10.999` son diez mil en es-MX y diez con 999 milésimas en inglés— y adivinar es un
// error de 1000× en una columna de dinero. Se rechaza pidiendo que lo desambigüe.
assert.throws(() => parseImporte('10.999'), DealError);
assert.throws(() => parseImporte('3.000'), DealError);
assert.throws(() => parseImporte('3,000'), DealError);
// El mensaje tiene que ofrecer las dos salidas, o el freno es una pared.
try {
  parseImporte('3.000');
  assert.fail('debía lanzar');
} catch (e) {
  assert.match((e as Error).message, /3000/, 'ofrece la lectura de miles');
  assert.match((e as Error).message, /decimales/, 'y la de decimales');
}
// Con dos decimales o sin separador no hay ambigüedad y pasa.
assert.strictEqual(parseImporte('3000'), '3000');
assert.strictEqual(parseImporte('10.99'), '10.99');
assert.strictEqual(parseImporte('3.0'), '3.0');

// Más de dos decimales no es dinero.
assert.throws(() => parseImporte('10.9999'), DealError);
assert.throws(() => parseImporte('hola'), DealError);
assert.throws(() => parseImporte('$'), DealError);
assert.throws(() => parseImporte({}), DealError);

// --- parseDealPatch -------------------------------------------------------------------
assert.deepStrictEqual(parseDealPatch({ title: '  Paneles casa María ' }), {
  title: 'Paneles casa María',
});
assert.deepStrictEqual(parseDealPatch({ amount: '3000' }), { amount: '3000' });
assert.deepStrictEqual(parseDealPatch({ amount: '' }), { amount: null });
assert.deepStrictEqual(parseDealPatch({ ownerId: null }), { ownerId: null });
const conFecha = parseDealPatch({ expectedCloseAt: '2026-09-01T00:00:00Z' }) as any;
assert.ok(conFecha.expectedCloseAt instanceof Date);
// El futuro es lo NORMAL aquí (es cuándo se espera cerrar), al revés que en una actividad.
assert.ok(parseDealPatch({ expectedCloseAt: '2030-01-01T00:00:00Z' }));
assert.deepStrictEqual(parseDealPatch({ expectedCloseAt: '' }), { expectedCloseAt: null });

// Ni el título ni la etapa se pueden vaciar.
assert.throws(() => parseDealPatch({ title: '' }), DealError);
assert.throws(() => parseDealPatch({ title: '   ' }), DealError);
assert.throws(() => parseDealPatch({ stageId: null }), DealError);

// `status` NO se toca por PATCH: cerrar tiene efecto de dominio (escribe su Activity y
// sella closedAt), y por aquí se podría dejar un `won` con closedAt nulo.
assert.throws(() => parseDealPatch({ status: 'won' }), DealError);
assert.throws(() => parseDealPatch({ closedAt: new Date().toISOString() }), DealError);
assert.throws(() => parseDealPatch({ lostReason: 'inventado' }), DealError);
assert.throws(() => parseDealPatch({ tenantId: 'otro' }), DealError);
// Mezclado con algo válido, lo prohibido no pasa.
assert.deepStrictEqual(parseDealPatch({ title: 'Ok', status: 'won', tenantId: 'x' }), {
  title: 'Ok',
});
assert.throws(() => parseDealPatch({}), DealError);

// --- parseCierre ----------------------------------------------------------------------
const ganado = parseCierre({ status: 'won' }, AHORA);
assert.strictEqual(ganado.status, 'won');
assert.strictEqual(ganado.closedAt?.toISOString(), AHORA.toISOString());
assert.strictEqual(ganado.lostReason, null);

// Perdido SIN motivo se rechaza. Es la única fricción añadida a propósito en el lote: es
// el dato más útil del CRM y nadie lo pone si es opcional.
assert.throws(() => parseCierre({ status: 'lost' }, AHORA), DealError);
assert.throws(() => parseCierre({ status: 'lost', lostReason: '   ' }, AHORA), DealError);
const perdido = parseCierre({ status: 'lost', lostReason: ' se fue con la competencia ' }, AHORA);
assert.strictEqual(perdido.lostReason, 'se fue con la competencia');
assert.strictEqual(perdido.closedAt?.toISOString(), AHORA.toISOString());
assert.throws(() => parseCierre({ status: 'lost', lostReason: 'x'.repeat(501) }, AHORA), DealError);

// Reabrir borra fecha Y motivo: si no, un trato reabierto seguiría diciendo por qué se
// perdió y el mes contaría un cierre que ya no existe.
const reabierto = parseCierre({ status: 'open' }, AHORA);
assert.strictEqual(reabierto.closedAt, null);
assert.strictEqual(reabierto.lostReason, null);

assert.throws(() => parseCierre({ status: 'cerrado' }, AHORA), DealError);
assert.throws(() => parseCierre({}, AHORA), DealError);

// --- tituloPorDefecto -----------------------------------------------------------------
assert.strictEqual(tituloPorDefecto('María López', 'x'), 'Oportunidad · María López');
// Sin nombre cae al identificador, sin el sufijo del canal.
assert.strictEqual(tituloPorDefecto(null, '5218711234567@c.us'), 'Oportunidad · 5218711234567');
assert.strictEqual(tituloPorDefecto('   ', '5218711234567@c.us'), 'Oportunidad · 5218711234567');

console.log('crm/deals.query.check OK');
