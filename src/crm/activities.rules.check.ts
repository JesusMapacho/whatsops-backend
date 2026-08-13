// Check de las reglas de actividades. Correr: npx ts-node src/crm/activities.rules.check.ts
import * as assert from 'node:assert';
import {
  ActivityError,
  MAX_BODY,
  TIPOS_MANUALES,
  parseActividadManual,
  parseCursor,
} from './activities.rules';

const AHORA = new Date('2026-08-12T20:00:00Z');

// --- allowlist de tipos ---------------------------------------------------------------
// Los tres que registra una persona.
for (const t of ['note', 'call', 'meeting']) {
  const a = parseActividadManual({ type: t, body: 'algo' }, AHORA);
  assert.strictEqual(a.type, t);
}
// Los que escribe el SERVIDOR cuando pasan de verdad no se pueden inyectar. Si esto se
// cayera, el timeline dejaría de ser un registro y las métricas comerciales se calculan
// sobre él.
for (const t of ['stage_change', 'deal_created', 'deal_won', 'deal_lost', 'task_done']) {
  assert.throws(
    () => parseActividadManual({ type: t, body: 'x' }, AHORA),
    ActivityError,
    `${t} no debe poder registrarse a mano`,
  );
}
assert.throws(() => parseActividadManual({ type: 'inventado' }, AHORA), ActivityError);
assert.throws(() => parseActividadManual({}, AHORA), ActivityError);
assert.throws(() => parseActividadManual(null, AHORA), ActivityError);
assert.strictEqual(TIPOS_MANUALES.length, 3);

// --- body -----------------------------------------------------------------------------
// Una NOTA sin texto no es nada.
assert.throws(() => parseActividadManual({ type: 'note' }, AHORA), ActivityError);
assert.throws(() => parseActividadManual({ type: 'note', body: '   ' }, AHORA), ActivityError);
// Una LLAMADA sin texto sí: que se llamó ya es información.
assert.strictEqual(parseActividadManual({ type: 'call' }, AHORA).body, undefined);
assert.strictEqual(parseActividadManual({ type: 'meeting', body: '' }, AHORA).body, undefined);
// Se recorta.
assert.strictEqual(parseActividadManual({ type: 'call', body: '  hola  ' }, AHORA).body, 'hola');
// Tope: sin él, este campo es un sitio donde pegar un megabyte y arrastrarlo en cada carga.
assert.throws(
  () => parseActividadManual({ type: 'call', body: 'x'.repeat(MAX_BODY + 1) }, AHORA),
  ActivityError,
);
assert.ok(parseActividadManual({ type: 'call', body: 'x'.repeat(MAX_BODY) }, AHORA));
assert.throws(() => parseActividadManual({ type: 'call', body: 42 }, AHORA), ActivityError);

// --- occurredAt -----------------------------------------------------------------------
// Ausente = ahora.
assert.strictEqual(
  parseActividadManual({ type: 'call' }, AHORA).occurredAt.toISOString(),
  AHORA.toISOString(),
);
// El caso que justifica que la columna exista: una llamada de ayer se registra hoy.
const ayer = '2026-08-11T18:00:00.000Z';
assert.strictEqual(
  parseActividadManual({ type: 'call', occurredAt: ayer }, AHORA).occurredAt.toISOString(),
  ayer,
);
// Futuro rechazado: lo que aún no ha pasado es una TAREA. Sin este freno el timeline
// mezcla historial con planes y deja de servir para las dos cosas.
assert.throws(
  () => parseActividadManual({ type: 'meeting', occurredAt: '2026-08-13T10:00:00Z' }, AHORA),
  ActivityError,
);
// Pero un minuto de margen sí, porque el reloj del navegador no va al milisegundo del
// servidor y "ahora" llega un instante en el futuro.
const casiAhora = new Date(AHORA.getTime() + 30_000).toISOString();
assert.ok(parseActividadManual({ type: 'call', occurredAt: casiAhora }, AHORA));
// Dos minutos ya no.
const dosMin = new Date(AHORA.getTime() + 120_000).toISOString();
assert.throws(() => parseActividadManual({ type: 'call', occurredAt: dosMin }, AHORA), ActivityError);
// Fecha basura.
assert.throws(() => parseActividadManual({ type: 'call', occurredAt: 'ayer' }, AHORA), ActivityError);
assert.throws(() => parseActividadManual({ type: 'call', occurredAt: 42 }, AHORA), ActivityError);

// --- parseCursor ----------------------------------------------------------------------
assert.strictEqual(parseCursor('2026-08-12T20:00:00Z')?.toISOString(), '2026-08-12T20:00:00.000Z');
// Basura se IGNORA en vez de fallar: una página mal pedida devuelve la primera, no rompe
// la pantalla.
assert.strictEqual(parseCursor('mañana'), undefined);
assert.strictEqual(parseCursor(''), undefined);
assert.strictEqual(parseCursor(undefined), undefined);
assert.strictEqual(parseCursor(42), undefined);

console.log('crm/activities.rules.check OK');
