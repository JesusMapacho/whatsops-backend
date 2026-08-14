// Check del alta y edición de tareas. Correr: npx ts-node src/crm/tasks.query.check.ts
import * as assert from 'node:assert';
import { componerDueAt } from './tasks.buckets';
import {
  TaskError,
  buildTaskWhere,
  parseComplete,
  parseTaskFilters,
  parseTaskNueva,
  parseTaskPatch,
} from './tasks.query';

const MX = 'America/Mexico_City'; // UTC-6 fijo
const MADRID = 'Europe/Madrid'; // UTC+1 / UTC+2

// --- componerDueAt --------------------------------------------------------------------
// Hora de pared del TENANT, no del servidor: 11:00 en México son 17:00Z.
assert.strictEqual(componerDueAt('2026-08-20', '11:00', MX).toISOString(), '2026-08-20T17:00:00.000Z');
// Sin hora, las 09:00 del día del tenant. Es lo que hace que "llamar el jueves" ordene
// coherente dentro de «Hoy» sin pedirle una hora a nadie.
assert.strictEqual(componerDueAt('2026-08-20', null, MX).toISOString(), '2026-08-20T15:00:00.000Z');
assert.strictEqual(componerDueAt('2026-08-20', undefined, MX).toISOString(), '2026-08-20T15:00:00.000Z');
// Una hora con formato raro cae al default en vez de lanzar: el formato ya lo valida
// `parseTaskNueva`, y aquí un fallo dejaría la tarea sin crear por un campo opcional.
assert.strictEqual(componerDueAt('2026-08-20', 'once', MX).toISOString(), '2026-08-20T15:00:00.000Z');

// Verano e invierno en la misma zona: el desplazamiento cambia y la hora de pared no.
assert.strictEqual(componerDueAt('2026-08-20', '09:00', MADRID).toISOString(), '2026-08-20T07:00:00.000Z');
assert.strictEqual(componerDueAt('2026-01-20', '09:00', MADRID).toISOString(), '2026-01-20T08:00:00.000Z');

// El día de la transición, lejos del salto: 09:00 del 29 de marzo ya es horario de verano.
assert.strictEqual(componerDueAt('2026-03-29', '09:00', MADRID).toISOString(), '2026-03-29T07:00:00.000Z');
assert.strictEqual(componerDueAt('2026-03-29', '00:30', MADRID).toISOString(), '2026-03-28T23:30:00.000Z');

// EL CASO QUE JUSTIFICA LA DOBLE CORRECCIÓN, y hay que buscarlo a propósito porque casi
// ninguna hora lo expone. La UE cambia a las 01:00 UTC.
//
// Primavera: el 29/03/2026 a las 01:00Z, Madrid salta de 02:00 CET a 03:00 CEST. Una tarea a
// las **01:30 hora local** todavía es CET (+1) → 00:30Z. Pero la primera pasada interpreta
// «01:30» como si fuera UTC, y 01:30Z ya está DESPUÉS del salto, así que mide el
// desplazamiento en CEST (+2) y daría 23:30Z del día anterior — una hora de menos y otro día.
// La segunda pasada mide el desplazamiento en el instante ya corregido y acierta.
assert.strictEqual(
  componerDueAt('2026-03-29', '01:30', MADRID).toISOString(),
  '2026-03-29T00:30:00.000Z',
  'con una sola pasada saldría 2026-03-28T23:30Z',
);

// Otoño, el mismo problema al revés: el 25/10/2026 a las 01:00Z Madrid vuelve de 03:00 CEST a
// 02:00 CET. Las 01:30 locales son todavía CEST (+2) → 23:30Z del día 24. Con una pasada
// saldría 00:30Z del 25.
assert.strictEqual(
  componerDueAt('2026-10-25', '01:30', MADRID).toISOString(),
  '2026-10-24T23:30:00.000Z',
  'con una sola pasada saldría 2026-10-25T00:30Z',
);

// Sin zona (tenant viejo sin onboarding) se compone en UTC, no se falla.
assert.strictEqual(componerDueAt('2026-08-20', '11:00', null).toISOString(), '2026-08-20T11:00:00.000Z');
assert.throws(() => componerDueAt('no-es-fecha', '11:00', MX));

// --- parseTaskNueva ------------------------------------------------------------------
const nueva = parseTaskNueva(
  { title: '  Llamar a María ', dueDate: '2026-08-20', dueTime: '11:00', dealId: 'd1' },
  MX,
);
assert.strictEqual(nueva.title, 'Llamar a María');
assert.strictEqual(nueva.type, 'call', 'el tipo por defecto es llamada');
assert.strictEqual(nueva.dueAt.toISOString(), '2026-08-20T17:00:00.000Z');
assert.strictEqual(nueva.dealId, 'd1');
assert.strictEqual(nueva.contactId, undefined, 'lo rellena el servicio desde el trato');
assert.strictEqual(nueva.assignedUserId, undefined, 'lo decide el servicio');

// Los cinco tipos pasan; cualquier otro se rechaza.
for (const t of ['call', 'whatsapp', 'email', 'meeting', 'other']) {
  assert.strictEqual(parseTaskNueva({ title: 'x', dueDate: '2026-08-20', type: t }, MX).type, t);
}
assert.throws(() => parseTaskNueva({ title: 'x', dueDate: '2026-08-20', type: 'llamada' }, MX), TaskError);

// `dueDate` es obligatorio: una tarea sin fecha no sale en ninguna lista, así que no existe.
assert.throws(() => parseTaskNueva({ title: 'x' }, MX), TaskError);
assert.throws(() => parseTaskNueva({ title: 'x', dueDate: '20/08/2026' }, MX), TaskError);
assert.throws(() => parseTaskNueva({ title: 'x', dueDate: '2026-08-20', dueTime: '11h' }, MX), TaskError);
// Título obligatorio y con tope.
assert.throws(() => parseTaskNueva({ dueDate: '2026-08-20' }, MX), TaskError);
assert.throws(() => parseTaskNueva({ title: '   ', dueDate: '2026-08-20' }, MX), TaskError);
assert.throws(() => parseTaskNueva({ title: 'x'.repeat(201), dueDate: '2026-08-20' }, MX), TaskError);
assert.throws(() => parseTaskNueva(null, MX), TaskError);

// --- parseTaskPatch -------------------------------------------------------------------
assert.deepStrictEqual(parseTaskPatch({ title: ' Nuevo ' }, MX), { title: 'Nuevo' });
assert.strictEqual(parseTaskPatch({ type: 'meeting' }, MX).type, 'meeting');
// Reprogramar manda el día, igual que al crear.
const repro = parseTaskPatch({ dueDate: '2026-08-21' }, MX) as any;
assert.strictEqual(repro.dueAt.toISOString(), '2026-08-21T15:00:00.000Z');
assert.deepStrictEqual(parseTaskPatch({ assignedUserId: 'u9' }, MX), { assignedUserId: 'u9' });

// Reasignar a nadie NO vale: `assignedUserId` no es nulable, una tarea de nadie no la hace
// nadie. Sin este freno Prisma fallaría con un error de columna, no con un mensaje útil.
assert.throws(() => parseTaskPatch({ assignedUserId: null }, MX), TaskError);
assert.throws(() => parseTaskPatch({ assignedUserId: '' }, MX), TaskError);

// Cerrar NO se hace por PATCH: tiene efecto de dominio (escribe su Activity), y por aquí se
// podría dejar una tarea cerrada sin registro en el timeline.
assert.throws(() => parseTaskPatch({ completedAt: new Date().toISOString() }, MX), TaskError);
assert.throws(() => parseTaskPatch({ outcome: 'ya está' }, MX), TaskError);
assert.throws(() => parseTaskPatch({ tenantId: 'otro' }, MX), TaskError);
assert.throws(() => parseTaskPatch({ dealId: 'd2' }, MX), TaskError, 'mover de trato no es editar');
// Mezclado con algo válido, lo prohibido no pasa.
assert.deepStrictEqual(parseTaskPatch({ title: 'Ok', completedAt: 'x', tenantId: 'y' }, MX), {
  title: 'Ok',
});
assert.throws(() => parseTaskPatch({}, MX), TaskError);

// --- parseComplete --------------------------------------------------------------------
assert.deepStrictEqual(parseComplete({ outcome: ' no contestó ' }), { outcome: 'no contestó' });
// Vacío se acepta: que la tarea se hizo ya es información, y exigir texto haría que la gente
// dejara tareas abiertas para no escribirlo.
assert.deepStrictEqual(parseComplete({}), { outcome: null });
assert.deepStrictEqual(parseComplete({ outcome: '' }), { outcome: null });
assert.deepStrictEqual(parseComplete({ outcome: '   ' }), { outcome: null });
assert.deepStrictEqual(parseComplete(null), { outcome: null });
assert.throws(() => parseComplete({ outcome: 42 }), TaskError);
assert.throws(() => parseComplete({ outcome: 'x'.repeat(2001) }), TaskError);

// --- parseTaskFilters -----------------------------------------------------------------
assert.deepStrictEqual(parseTaskFilters({}), {
  assignedUserId: undefined,
  dealId: undefined,
  contactId: undefined,
  type: undefined,
  equipo: false,
});
// Un tipo mal escrito se ignora en vez de fallar: un filtro roto devuelve la lista.
assert.strictEqual(parseTaskFilters({ type: 'basura' }).type, undefined);
assert.strictEqual(parseTaskFilters({ type: 'meeting' }).type, 'meeting');
// Solo el string 'true' cuenta, como en `sinTrato` de contactos.
assert.strictEqual(parseTaskFilters({ equipo: 'false' }).equipo, false);
assert.strictEqual(parseTaskFilters({ equipo: 'true' }).equipo, true);

// --- buildTaskWhere -------------------------------------------------------------------
const alcanceAgente = { assignedUserId: 'u1' };
assert.deepStrictEqual(buildTaskWhere('t1', parseTaskFilters({}), alcanceAgente), {
  tenantId: 't1',
  assignedUserId: 'u1',
});
// El tenantId NUNCA falta, ni con alcance de admin.
assert.deepStrictEqual(buildTaskWhere('t1', parseTaskFilters({}), {}), { tenantId: 't1' });

// EL CASO QUE IMPORTA, y que una prueba end-to-end pilló porque este check afirmaba lo
// contrario: `?assignedUserId=<otro>` NO puede pisar el alcance. El alcance llega por spread
// como `{ assignedUserId: <yo> }`, así que asignar la clave la sustituiría y un agente vería
// la agenda del resto del equipo. Va en `AND`: las dos condiciones conviven y la consulta sale
// vacía, que es lo correcto.
const intento = buildTaskWhere('t1', parseTaskFilters({ assignedUserId: 'u2' }), alcanceAgente) as any;
assert.strictEqual(intento.tenantId, 't1');
assert.strictEqual(intento.assignedUserId, 'u1', 'el alcance del agente SOBREVIVE');
assert.deepStrictEqual(intento.AND, [{ assignedUserId: 'u2' }], 'el filtro pedido va en AND');

// Con alcance de admin (vacío) el filtro sí acota de verdad, porque no hay nada que pisar.
const comoAdmin = buildTaskWhere('t1', parseTaskFilters({ assignedUserId: 'u2' }), {}) as any;
assert.strictEqual(comoAdmin.assignedUserId, undefined);
assert.deepStrictEqual(comoAdmin.AND, [{ assignedUserId: 'u2' }]);

// Los demás filtros van igual aunque hoy no choquen con el alcance: así un cambio futuro en
// `taskScope` no vuelve a abrir el agujero.
const conFiltros = buildTaskWhere('t1', parseTaskFilters({ dealId: 'd1', type: 'call' }), alcanceAgente) as any;
assert.strictEqual(conFiltros.assignedUserId, 'u1', 'el alcance sigue ahí');
assert.deepStrictEqual(conFiltros.AND, [{ dealId: 'd1' }, { type: 'call' }]);
// Sin filtros no se añade un AND vacío, que Prisma trataría como una condición más.
assert.strictEqual(buildTaskWhere('t1', parseTaskFilters({}), alcanceAgente).AND, undefined);

console.log('crm/tasks.query.check OK');
