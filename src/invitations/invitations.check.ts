// Check de las invitaciones. Correr: npx ts-node src/invitations/invitations.check.ts
import * as assert from 'node:assert';
import { caducaEn, correosDe, esCorreo, TTL_DIAS, vigente } from './correos';

// ── Leer la lista pegada ──────────────────────────────────────────────────────
// Comas, saltos y punto y coma: el admin pega de donde sea.
assert.deepStrictEqual(correosDe('a@b.com, c@d.com'), ['a@b.com', 'c@d.com']);
assert.deepStrictEqual(correosDe('a@b.com\nc@d.com;e@f.com'), ['a@b.com', 'c@d.com', 'e@f.com']);

// Espacios y mayúsculas no crean direcciones distintas.
assert.deepStrictEqual(correosDe('  A@B.com ,a@b.com'), ['a@b.com']);

// LA ASERCIÓN QUE IMPORTA: el mismo correo repetido manda UN enlace, no dos.
// Sin esto, pegar una lista con duplicados genera invitaciones que se pisan y la
// primera queda muerta sin que nadie lo sepa.
assert.deepStrictEqual(correosDe('x@y.com,x@y.com,x@y.com'), ['x@y.com']);

// Vacío y basura no cuentan como destinatario.
assert.deepStrictEqual(correosDe(''), []);
assert.deepStrictEqual(correosDe(',,  ,\n'), []);
assert.deepStrictEqual(correosDe(null), []);

// También acepta el array ya partido por el cliente.
assert.deepStrictEqual(correosDe(['A@b.com', ' c@d.com']), ['a@b.com', 'c@d.com']);

// ── Formato ───────────────────────────────────────────────────────────────────
assert.ok(esCorreo('ana@nordika.es'));
assert.ok(!esCorreo('ana@nordika'), 'sin dominio de primer nivel no vale');
assert.ok(!esCorreo('ana nordika.es'));
assert.ok(!esCorreo(''));
assert.ok(!esCorreo(undefined));

// ── Caducidad ─────────────────────────────────────────────────────────────────
const ahora = new Date('2026-08-11T12:00:00Z');
assert.strictEqual(caducaEn(ahora).toISOString(), '2026-08-18T12:00:00.000Z');
assert.strictEqual(TTL_DIAS, 7);

const base = { acceptedAt: null as Date | null, revokedAt: null as Date | null };
const dias = (n: number) => new Date(ahora.getTime() + n * 24 * 60 * 60 * 1000);

assert.ok(vigente({ ...base, expiresAt: dias(1) }, ahora), 'con margen, abre');
assert.ok(!vigente({ ...base, expiresAt: dias(-1) }, ahora), 'caducada, no abre');
// El borde exacto cuenta como caducada: si el reloj llegó, se acabó.
assert.ok(!vigente({ ...base, expiresAt: ahora }, ahora));

// Un enlace ya usado no vuelve a servir aunque le quede tiempo: es de un solo uso.
assert.ok(!vigente({ ...base, acceptedAt: ahora, expiresAt: dias(5) }, ahora));
// Anulada tampoco, y esa es la única forma de cortar un enlace ya repartido.
assert.ok(!vigente({ ...base, revokedAt: ahora, expiresAt: dias(5) }, ahora));

console.log('invitations.check OK');
