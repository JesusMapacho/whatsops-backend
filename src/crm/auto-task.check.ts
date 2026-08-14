// Check de la tarea automática de etapa. Correr: npx ts-node src/crm/auto-task.check.ts
import * as assert from 'node:assert';
import { anotacionDe, decidirTareaAuto, diaMasN } from './auto-task';

const MX = 'America/Mexico_City'; // UTC-6 fijo
const MADRID = 'Europe/Madrid'; // UTC+1 / UTC+2

// --- diaMasN --------------------------------------------------------------------------
// Base: 13 de agosto de 2026, 14:00 en México (20:00 UTC).
const AHORA = new Date('2026-08-13T20:00:00Z');
assert.strictEqual(diaMasN(AHORA, 0, MX), '2026-08-13');
assert.strictEqual(diaMasN(AHORA, 2, MX), '2026-08-15');
// Desborde de mes y de año, que es lo que `Date.UTC` normaliza gratis.
assert.strictEqual(diaMasN(new Date('2026-08-30T20:00:00Z'), 2, MX), '2026-09-01');
assert.strictEqual(diaMasN(new Date('2026-12-31T20:00:00Z'), 2, MX), '2027-01-02');
// Año bisiesto.
assert.strictEqual(diaMasN(new Date('2028-02-28T20:00:00Z'), 1, MX), '2028-02-29');

// La zona decide de qué día se parte: a las 02:00 UTC del 14 todavía es el 13 en México.
assert.strictEqual(diaMasN(new Date('2026-08-14T02:00:00Z'), 0, MX), '2026-08-13');
assert.strictEqual(diaMasN(new Date('2026-08-14T02:00:00Z'), 0, 'UTC'), '2026-08-14');

// EL MOTIVO DE USAR ARITMÉTICA DE CALENDARIO: el día del cambio de horario mide 23 o 25 horas,
// así que sumar milisegundos puede correr el día. Partiendo del 28 de marzo (Madrid adelanta el
// 29), +2 días tiene que ser el 30 exacto.
assert.strictEqual(diaMasN(new Date('2026-03-28T12:00:00Z'), 2, MADRID), '2026-03-30');
// Y en octubre, que atrasa.
assert.strictEqual(diaMasN(new Date('2026-10-24T12:00:00Z'), 2, MADRID), '2026-10-26');
// Cruzando la transición desde el día anterior a medianoche larga.
assert.strictEqual(diaMasN(new Date('2026-03-29T00:30:00Z'), 1, MADRID), '2026-03-30');

// --- decidirTareaAuto: omisiones -------------------------------------------------------
const sinNada = decidirTareaAuto({
  stage: { name: 'Contactado' },
  dealOwnerId: 'u1',
  dealTitle: 'Trato',
  ahora: AHORA,
  timezone: MX,
});
assert.deepStrictEqual(sinNada, { crear: false, motivo: 'sin-configurar' });

// Medio configurada (título sin plazo, o plazo sin título) cuenta como sin configurar: los dos
// campos o ninguno. La UI ya lo valida, pero una fila vieja o tocada a mano puede estar así.
assert.strictEqual(
  decidirTareaAuto({
    stage: { name: 'x', autoTaskTitle: 'Llamar', autoTaskDays: null },
    dealOwnerId: 'u1', dealTitle: 't', ahora: AHORA, timezone: MX,
  }).crear,
  false,
);
assert.strictEqual(
  decidirTareaAuto({
    stage: { name: 'x', autoTaskTitle: '   ', autoTaskDays: 2 },
    dealOwnerId: 'u1', dealTitle: 't', ahora: AHORA, timezone: MX,
  }).crear,
  false,
);
assert.strictEqual(
  decidirTareaAuto({
    stage: { name: 'x', autoTaskDays: 2 },
    dealOwnerId: 'u1', dealTitle: 't', ahora: AHORA, timezone: MX,
  }).crear,
  false,
);

// EL CASO QUE HAY QUE CONTAR: etapa bien configurada pero trato SIN DUEÑO. No se crea, porque
// `Task.assignedUserId` no es nulable y una tarea de nadie no la hace nadie. Es lo que les pasa
// a los tratos del alta automática, que nacen sin responsable a propósito.
const sinDueno = decidirTareaAuto({
  stage: { name: 'Cotización enviada', autoTaskTitle: 'Llamar para revisar', autoTaskDays: 2 },
  dealOwnerId: null,
  dealTitle: 'Trato',
  ahora: AHORA,
  timezone: MX,
});
assert.deepStrictEqual(sinDueno, { crear: false, motivo: 'sin-dueno' });

// --- decidirTareaAuto: creación --------------------------------------------------------
const creada = decidirTareaAuto({
  stage: { name: 'Cotización enviada', autoTaskTitle: '  Llamar para revisar  ', autoTaskDays: 2 },
  dealOwnerId: 'u9',
  dealTitle: 'Paneles casa María',
  ahora: AHORA,
  timezone: MX,
});
assert.strictEqual(creada.crear, true);
if (creada.crear) {
  assert.strictEqual(creada.title, 'Llamar para revisar', 'recorta el título');
  assert.strictEqual(creada.assignedUserId, 'u9', 'para el dueño del trato');
  assert.strictEqual(creada.type, 'call');
  // 09:00 del 15 de agosto en México = 15:00Z.
  assert.strictEqual(creada.dueAt.toISOString(), '2026-08-15T15:00:00.000Z');
}

// Cero días = hoy mismo a las 09:00, que es válido (puede quedar en el pasado si ya son las 14h;
// aparecerá en «Hoy», no en atrasadas, porque los cubos van por día natural).
const hoyMismo = decidirTareaAuto({
  stage: { name: 'x', autoTaskTitle: 'Ya', autoTaskDays: 0 },
  dealOwnerId: 'u1', dealTitle: 't', ahora: AHORA, timezone: MX,
});
assert.ok(hoyMismo.crear && hoyMismo.dueAt.toISOString() === '2026-08-13T15:00:00.000Z');

// Días negativos o decimales no producen fechas raras: se truncan y se acotan a 0.
const raro = decidirTareaAuto({
  stage: { name: 'x', autoTaskTitle: 'Ya', autoTaskDays: -5 },
  dealOwnerId: 'u1', dealTitle: 't', ahora: AHORA, timezone: MX,
});
assert.ok(raro.crear && raro.dueAt.toISOString() === '2026-08-13T15:00:00.000Z');
const decimal = decidirTareaAuto({
  stage: { name: 'x', autoTaskTitle: 'Ya', autoTaskDays: 2.7 },
  dealOwnerId: 'u1', dealTitle: 't', ahora: AHORA, timezone: MX,
});
assert.ok(decimal.crear && decimal.dueAt.toISOString() === '2026-08-15T15:00:00.000Z');

// --- anotacionDe ----------------------------------------------------------------------
assert.strictEqual(anotacionDe(creada), 'creada');
assert.strictEqual(anotacionDe(sinDueno), 'sin-dueno');
// Sin configurar NO se anota: escribirlo en cada movimiento llenaría el timeline de ruido
// sobre algo que nadie pidió.
assert.strictEqual(anotacionDe(sinNada), undefined);

console.log('crm/auto-task.check OK');
