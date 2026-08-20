// Check de la URL pública de las automatizaciones. Correr: npm run check.
//
// Esto es lo que decide si un DESCONOCIDO ejecuta algo en el tenant de otro. Si alguno de
// estos asserts deja de pasar, la puerta se abrió sola.
import * as assert from 'node:assert';
import {
  TOPE_CUERPO_BYTES,
  aceptaHook,
  claveDeVentana,
  cuerpoDemasiadoGrande,
  estadoDe,
  nuevoTokenDeHook,
  pareceToken,
  segundosRestantes,
  urlDelHook,
} from './hooks';

// --- forma del token -------------------------------------------------------------------
const t = nuevoTokenDeHook();
assert.ok(pareceToken(t), 'el que generamos tiene que pasar nuestro propio filtro');
assert.strictEqual(t.length, 32, '24 bytes en base64url son 32 caracteres = 192 bits');

// 1000 tiradas, todas distintas: si esto falla, el generador no es aleatorio.
const vistos = new Set<string>();
for (let i = 0; i < 1000; i++) vistos.add(nuevoTokenDeHook());
assert.strictEqual(vistos.size, 1000);

// El backfill de la migración produce 32 hex (uuid sin guiones): tiene que pasar igual, o
// las automatizaciones que ya existían responderían 404 para siempre.
assert.ok(pareceToken('0f8b2c1d4e6a7b9c0d1e2f3a4b5c6d7e'), 'los 32 hex del backfill valen');

for (const malo of ['', 'abc', 'a'.repeat(31), 'a'.repeat(33), '../../etc/passwd', 'ab+/cd', null, 42, undefined]) {
  assert.ok(!pareceToken(malo), `«${String(malo)}» no debería pasar`);
}
// base64 clásico (con + y /) no: la ruta se partiría por la barra.
assert.ok(!pareceToken('ab+cd/efghijklmnopqrstuvwxyz1234'));

// --- aceptaHook: la tabla de verdad ------------------------------------------------------
const wh = { type: 'webhook.received' };
const ok = (o: object) => aceptaHook({ status: 'active', trigger: wh, tenantStatus: 'active', ...o });

assert.deepStrictEqual(ok({}), { ok: true });
assert.deepStrictEqual(aceptaHook(null), { ok: false, motivo: 'no-existe' });
assert.deepStrictEqual(ok({ status: 'draft' }), { ok: false, motivo: 'borrador' });
assert.deepStrictEqual(ok({ tenantStatus: 'suspended' }), { ok: false, motivo: 'tenant-suspendido' });
// Una automatización con OTRO disparador no se puede disparar por URL aunque tenga token:
// todas lo tienen desde que se crean.
assert.deepStrictEqual(ok({ trigger: { type: 'message.inbound' } }), { ok: false, motivo: 'no-es-webhook' });

// Un trigger corrupto en la columna Json nunca puede dar «ok»: en la duda, no se ejecuta.
for (const basura of [null, {}, { type: 42 }, 'webhook.received', [], { tipo: 'webhook.received' }]) {
  assert.strictEqual(ok({ trigger: basura }).ok, false, `trigger ${JSON.stringify(basura)}`);
}

// El tenant se mira ANTES que el disparador: una cuenta suspendida no ejecuta nada de nada.
assert.deepStrictEqual(
  aceptaHook({ status: 'active', trigger: wh, tenantStatus: 'suspended' }),
  { ok: false, motivo: 'tenant-suspendido' },
);

// --- estadoDe: qué se le cuenta a un desconocido -----------------------------------------
assert.strictEqual(estadoDe('borrador'), 409, 'apagada sí se dice: ya tiene el token');
for (const m of ['no-existe', 'no-es-webhook', 'tenant-suspendido'] as const) {
  assert.strictEqual(estadoDe(m), 404, `${m} no confirma nada`);
}

// --- tope de cuerpo ----------------------------------------------------------------------
assert.ok(!cuerpoDemasiadoGrande(TOPE_CUERPO_BYTES), 'el tope justo entra');
assert.ok(cuerpoDemasiadoGrande(TOPE_CUERPO_BYTES + 1));
assert.ok(!cuerpoDemasiadoGrande(0), 'un ping sin cuerpo es legítimo');

// --- ventana del tope de ritmo -----------------------------------------------------------
const t0 = 1_770_000_000_000; // un instante cualquiera, alineado al minuto
assert.strictEqual(claveDeVentana('a', 'x', t0), claveDeVentana('a', 'x', t0 + 59_999), 'mismo minuto, misma clave');
assert.notStrictEqual(claveDeVentana('a', 'x', t0), claveDeVentana('a', 'x', t0 + 60_000), 'el minuto siguiente, otra');
assert.notStrictEqual(claveDeVentana('a', 'x', t0), claveDeVentana('t', 'x', t0), 'automatización y tenant no comparten cuenta');
assert.notStrictEqual(claveDeVentana('a', 'x', t0), claveDeVentana('a', 'y', t0), 'una automatización no gasta la cuota de otra');

for (const ms of [t0, t0 + 1, t0 + 30_000, t0 + 59_999]) {
  const s = segundosRestantes(ms);
  assert.ok(s >= 1 && s <= 60, `Retry-After fuera de rango: ${s}`);
}

// --- la URL que se copia ------------------------------------------------------------------
assert.strictEqual(urlDelHook('https://api.mx', 'abc'), 'https://api.mx/hooks/abc');
assert.strictEqual(urlDelHook('https://api.mx/', 'abc'), 'https://api.mx/hooks/abc', 'sin barra doble');
assert.strictEqual(urlDelHook('https://api.mx///', 'abc'), 'https://api.mx/hooks/abc');
assert.strictEqual(urlDelHook('https://api.mx', null), null);
assert.strictEqual(urlDelHook('https://api.mx', undefined), null);

console.log('hooks.check OK');
