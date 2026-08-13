// Check de la consulta y el patch de contactos. Correr: npx ts-node src/crm/contacts.query.check.ts
import * as assert from 'node:assert';
import {
  ContactPatchError,
  buildContactWhere,
  parseContactFilters,
  parseContactPatch,
  parseTagIds,
} from './contacts.query';

const T = 'tenant1';

// --- buildContactWhere ----------------------------------------------------------------
// Sin filtros: solo tenant. El tenantId NUNCA falta.
assert.deepStrictEqual(buildContactWhere(T), { tenantId: T });

// Búsqueda: cinco campos, y los de identidad SIN `mode` insensible (son dígitos/ids, y
// con `mode` Postgres descartaría el índice).
const buscado = buildContactWhere(T, { q: 'ACME' }) as any;
assert.strictEqual(buscado.tenantId, T);
assert.strictEqual(buscado.OR.length, 5);
assert.ok(buscado.OR.some((c: any) => c.company?.mode === 'insensitive'));
assert.ok(buscado.OR.some((c: any) => c.waId && c.waId.mode === undefined));
assert.ok(buscado.OR.some((c: any) => c.phone && c.phone.mode === undefined));
// q en blanco no agrega OR (si no, un espacio vaciaría la lista).
assert.deepStrictEqual(buildContactWhere(T, { q: '   ' }), { tenantId: T });

// Etiqueta y dueño restringen.
assert.deepStrictEqual(buildContactWhere(T, { tagId: 'tg1' }), {
  tenantId: T,
  tags: { some: { tagId: 'tg1' } },
});
assert.deepStrictEqual(buildContactWhere(T, { ownerId: 'u1' }), { tenantId: T, ownerId: 'u1' });

// sinTrato = ningún trato ABIERTO, no "ningún trato nunca": quien ya compró y volvió a
// escribir es exactamente a quien hay que mirar.
const sinTrato = buildContactWhere(T, { sinTrato: true }) as any;
assert.deepStrictEqual(sinTrato.deals, { none: { status: 'open' } });

// Los filtros se acumulan sin pisarse.
const todo = buildContactWhere(T, { q: 'ana', tagId: 'tg1', ownerId: 'u1', sinTrato: true }) as any;
assert.strictEqual(todo.tenantId, T);
assert.strictEqual(todo.OR.length, 5);
assert.strictEqual(todo.tags.some.tagId, 'tg1');
assert.strictEqual(todo.ownerId, 'u1');
assert.deepStrictEqual(todo.deals, { none: { status: 'open' } });

// --- parseContactFilters --------------------------------------------------------------
assert.deepStrictEqual(parseContactFilters({}), {
  q: undefined,
  tagId: undefined,
  ownerId: undefined,
  sinTrato: false,
});
// El caso que un `Boolean(query.sinTrato)` haría al revés de lo que dice la URL.
assert.strictEqual(parseContactFilters({ sinTrato: 'false' }).sinTrato, false);
assert.strictEqual(parseContactFilters({ sinTrato: 'true' }).sinTrato, true);
assert.strictEqual(parseContactFilters({ q: '  ana  ' }).q, 'ana');
assert.strictEqual(parseContactFilters({ q: '   ' }).q, undefined);

// --- parseContactPatch ----------------------------------------------------------------
assert.deepStrictEqual(parseContactPatch({ name: 'Ana López' }), { name: 'Ana López' });
assert.deepStrictEqual(parseContactPatch({ company: '  ACME  ' }), { company: 'ACME' });
// Cadena vacía = borrar el dato, no ignorarlo: si no, un correo mal escrito no se podría
// quitar nunca.
assert.deepStrictEqual(parseContactPatch({ email: '' }), { email: null });
assert.deepStrictEqual(parseContactPatch({ ownerId: null }), { ownerId: null });
assert.deepStrictEqual(parseContactPatch({ company: '   ' }), { company: null });

// La IDENTIDAD no es editable: es lo que empareja los entrantes. Se IGNORA, y como no
// queda nada que actualizar, lanza.
assert.throws(() => parseContactPatch({ waId: '5218711234567@c.us' }), ContactPatchError);
assert.throws(() => parseContactPatch({ phone: '5218711234567' }), ContactPatchError);
assert.throws(() => parseContactPatch({ platform: 'waha' }), ContactPatchError);
assert.throws(() => parseContactPatch({ tenantId: 'otro' }), ContactPatchError);
// Y si viene mezclado con algo válido, lo prohibido no pasa.
assert.deepStrictEqual(parseContactPatch({ name: 'Ana', waId: 'x', tenantId: 'otro' }), {
  name: 'Ana',
});

assert.throws(() => parseContactPatch({}), ContactPatchError);
assert.throws(() => parseContactPatch(null), ContactPatchError);
assert.throws(() => parseContactPatch({ name: 42 }), ContactPatchError);
assert.throws(() => parseContactPatch({ email: 'no-es-correo' }), ContactPatchError);
assert.deepStrictEqual(parseContactPatch({ email: 'a@b.mx' }), { email: 'a@b.mx' });

// --- parseTagIds ----------------------------------------------------------------------
// Juego vacío = quitar todas las etiquetas.
assert.deepStrictEqual(parseTagIds({}), []);
assert.deepStrictEqual(parseTagIds({ tagIds: [] }), []);
assert.deepStrictEqual(parseTagIds({ tagIds: ['a', 'b'] }), ['a', 'b']);
// Un solo id como string no es "ninguno" (el mismo caso que `pick.check.ts` de carteras).
assert.deepStrictEqual(parseTagIds({ tagIds: 'a' }), ['a']);
// Repetidos deduplicados: la clave es (contactId, tagId), así que un duplicado reventaría
// el createMany en vez de ser un no-op.
assert.deepStrictEqual(parseTagIds({ tagIds: ['a', 'a', 'b'] }), ['a', 'b']);
// Basura fuera.
assert.deepStrictEqual(parseTagIds({ tagIds: ['a', '', null, 42, '  b  '] }), ['a', 'b']);

console.log('crm/contacts.query.check OK');
