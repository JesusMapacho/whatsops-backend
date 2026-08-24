// Check de los cubos de tareas. Correr: npx ts-node src/crm/tasks.buckets.check.ts
//
// GEMELO de frontend/src/app/tareas/tareas.buckets.check.ts: los mismos casos límite en
// los dos lados, porque el criterio está duplicado a propósito. Si cambias uno, cambia
// el otro o dejarán de contar lo mismo.
//
// Lo gemelo es el CLASIFICADOR: `bucket` y `diaEn`. `SCOPES`, `parseScope`, `rangoDeScope`,
// `inicioDelDia` y `componerDueAt` solo existen de este lado —el frontend reordena una lista
// que ya le llega repartida— así que tocarlos no obliga a tocar el otro archivo. Comprobado
// al añadir `agenda`; se deja escrito para que no haya que volver a comprobarlo.
import * as assert from 'node:assert';
import { bucket, diaEn, inicioDelDia, parseScope, rangoDeScope } from './tasks.buckets';

const MX = 'America/Mexico_City'; // UTC-6 (CST, sin horario de verano desde 2022)

// --- diaEn ----------------------------------------------------------------------------
// El caso que motiva todo el módulo: 2026-08-12 a las 02:00 UTC es todavía el 11 en México.
assert.strictEqual(diaEn(new Date('2026-08-12T02:00:00Z'), MX), '2026-08-11');
assert.strictEqual(diaEn(new Date('2026-08-12T02:00:00Z'), 'UTC'), '2026-08-12');
// Zona nula (tenant viejo, sin onboarding completo) → UTC, no un fallo.
assert.strictEqual(diaEn(new Date('2026-08-12T02:00:00Z'), null), '2026-08-12');
// Zona basura → UTC en vez de lanzar: no ver la agenda es peor que un corte de día raro.
assert.strictEqual(diaEn(new Date('2026-08-12T02:00:00Z'), 'Marte/Olympus'), '2026-08-12');

// --- bucket ---------------------------------------------------------------------------
const tarea = (dueAt: string, completedAt?: string) => ({
  dueAt: new Date(dueAt),
  completedAt: completedAt ? new Date(completedAt) : null,
});

// Son las 14:00 del 12 de agosto en México (20:00 UTC).
const AHORA = new Date('2026-08-12T20:00:00Z');

// El caso límite: 23:59 de HOY es «hoy», no «atrasada».
assert.strictEqual(bucket(tarea('2026-08-13T05:59:00Z'), AHORA, MX), 'hoy', '23:59 local es hoy');
// Y una de hoy que ya pasó de hora SIGUE siendo «hoy»: el corte es por día natural, no
// por instante. Si no, la lista se vaciaría hacia Atrasadas durante la jornada y la
// pantalla pasaría de ser un plan a ser un reproche.
assert.strictEqual(bucket(tarea('2026-08-12T15:00:00Z'), AHORA, MX), 'hoy', '09:00 local sigue hoy');
// Ayer sin cerrar → atrasada.
assert.strictEqual(bucket(tarea('2026-08-11T18:00:00Z'), AHORA, MX), 'atrasada');
// Mañana → próxima.
assert.strictEqual(bucket(tarea('2026-08-13T18:00:00Z'), AHORA, MX), 'proxima');
// Completada es «hecha» aunque venciera hace un mes: se comprueba ANTES de la fecha.
assert.strictEqual(
  bucket(tarea('2026-07-01T18:00:00Z', '2026-07-02T10:00:00Z'), AHORA, MX),
  'hecha',
);

// La zona cambia el cubo con el MISMO instante, que es justo el bug que esto evita: una
// tarea de las 19:00 del día 12 en México es el día 13 en UTC.
const tardeEnMexico = tarea('2026-08-13T01:00:00Z'); // 12 ago 19:00 en MX, 13 ago en UTC
assert.strictEqual(bucket(tardeEnMexico, AHORA, MX), 'hoy');
assert.strictEqual(bucket(tardeEnMexico, AHORA, 'UTC'), 'proxima');

// --- parseScope -----------------------------------------------------------------------
assert.strictEqual(parseScope('atrasadas'), 'atrasadas');
assert.strictEqual(parseScope('todas'), 'todas');
// Basura o ausente → «hoy»: es la pregunta con la que se abre el sistema por la mañana.
assert.strictEqual(parseScope('basura'), 'hoy');
assert.strictEqual(parseScope(undefined), 'hoy');
assert.strictEqual(parseScope(42), 'hoy');
assert.strictEqual(parseScope('agenda'), 'agenda');

// --- inicioDelDia ---------------------------------------------------------------------
// Medianoche del 12 de agosto en México = 06:00 UTC del 12.
assert.strictEqual(inicioDelDia(AHORA, MX).toISOString(), '2026-08-12T06:00:00.000Z');
assert.strictEqual(inicioDelDia(AHORA, 'UTC').toISOString(), '2026-08-12T00:00:00.000Z');
// Zona con horario de verano: Madrid en agosto es UTC+2, así que su medianoche es 22:00
// UTC del día anterior. Un `-1h` a mano fallaría aquí.
assert.strictEqual(
  inicioDelDia(new Date('2026-08-12T12:00:00Z'), 'Europe/Madrid').toISOString(),
  '2026-08-11T22:00:00.000Z',
);
// Y en enero, la misma zona es UTC+1.
assert.strictEqual(
  inicioDelDia(new Date('2026-01-15T12:00:00Z'), 'Europe/Madrid').toISOString(),
  '2026-01-14T23:00:00.000Z',
);

// --- rangoDeScope ---------------------------------------------------------------------
const hoyMx = rangoDeScope('hoy', AHORA, MX);
assert.strictEqual(hoyMx.desde!.toISOString(), '2026-08-12T06:00:00.000Z');
assert.strictEqual(hoyMx.hasta!.toISOString(), '2026-08-13T06:00:00.000Z');
assert.strictEqual(hoyMx.completadas, false);
// «hasta» es EXCLUSIVO y encaja con el «desde» de próximas: sin hueco y sin solape, así
// que ninguna tarea se cae entre dos cubos ni sale en los dos.
assert.strictEqual(
  rangoDeScope('proximas', AHORA, MX).desde!.toISOString(),
  hoyMx.hasta!.toISOString(),
);
// Atrasadas: todo lo anterior al inicio de hoy, y solo sin completar.
const atr = rangoDeScope('atrasadas', AHORA, MX);
assert.strictEqual(atr.hasta!.toISOString(), hoyMx.desde!.toISOString());
assert.strictEqual(atr.desde, undefined);
assert.strictEqual(atr.completadas, false);
// «todas» no filtra por completadas, y `null` NO es lo mismo que `false`.
assert.strictEqual(rangoDeScope('todas', AHORA, MX).completadas, null);
assert.strictEqual(rangoDeScope('hechas', AHORA, MX).completadas, true);

// «agenda» es la lista de la pantalla nueva: los cuatro cubos de una sola consulta. No acota
// `dueAt` —si lo hiciera faltaría uno de los cubos— y no filtra por completadas: deja pasar
// las abiertas Y las cerradas desde `cerradasDesde`.
const agenda = rangoDeScope('agenda', AHORA, MX);
assert.strictEqual(agenda.desde, undefined, 'agenda no acota dueAt por abajo');
assert.strictEqual(agenda.hasta, undefined, 'agenda no acota dueAt por arriba');
assert.strictEqual(agenda.completadas, null, 'ni solo abiertas ni solo cerradas');
// Medianoche del día de hace siete EN LA ZONA DEL TENANT: hoy es el 12 en México, así que el
// corte es la medianoche del 5, no «ahora menos 168 h» (que caería a las 20:00 del 5).
assert.strictEqual(agenda.cerradasDesde!.toISOString(), '2026-08-05T06:00:00.000Z');
// Y ningún otro scope lo trae: es lo que distingue `agenda` de `todas`.
assert.strictEqual(rangoDeScope('todas', AHORA, MX).cerradasDesde, undefined);
assert.strictEqual(rangoDeScope('hechas', AHORA, MX).cerradasDesde, undefined);

// --- el día del cambio de horario de verano ------------------------------------------
// El día de la transición dura 23 o 25 horas, así que "hoy + 24 h" desvía el corte una hora
// y se lleva de cubo las tareas del borde. Madrid adelanta el último domingo de marzo
// (2026-03-29, día de 23 h) y atrasa el último de octubre (2026-10-25, día de 25 h).
const MADRID = 'Europe/Madrid';

// 29 de marzo de 2026 a mediodía en Madrid. El inicio de mañana tiene que ser la medianoche
// del 30, no 24 h después de la del 29.
const marzo = rangoDeScope('hoy', new Date('2026-03-29T10:00:00Z'), MADRID);
assert.strictEqual(marzo.desde!.toISOString(), '2026-03-28T23:00:00.000Z', 'medianoche del 29');
assert.strictEqual(marzo.hasta!.toISOString(), '2026-03-29T22:00:00.000Z', 'medianoche del 30');
// La prueba de que el día midió 23 h y no 24: con la suma ingenua habría dado 23:00Z.
assert.strictEqual(
  (marzo.hasta!.getTime() - marzo.desde!.getTime()) / 3_600_000,
  23,
  'el día de marzo dura 23 h',
);

// 25 de octubre de 2026: día de 25 h.
const octubre = rangoDeScope('hoy', new Date('2026-10-25T10:00:00Z'), MADRID);
assert.strictEqual(
  (octubre.hasta!.getTime() - octubre.desde!.getTime()) / 3_600_000,
  25,
  'el día de octubre dura 25 h',
);

// Y los cubos siguen encajando sin hueco ni solape también en la transición.
assert.strictEqual(
  rangoDeScope('proximas', new Date('2026-03-29T10:00:00Z'), MADRID).desde!.toISOString(),
  marzo.hasta!.toISOString(),
);
// La ventana de siete días de `agenda` también se re-ancla, y por el mismo motivo: siete días
// que cruzan una transición NO miden 168 h. Restando `7 × 24 h` el corte se iría una hora y
// dejaría de ser una medianoche, que es lo único que hace comparable «cerrada hace 7 días»
// entre dos semanas del año.
const semanaMarzo = rangoDeScope('agenda', new Date('2026-04-02T10:00:00Z'), MADRID);
assert.strictEqual(
  semanaMarzo.cerradasDesde!.toISOString(),
  '2026-03-25T23:00:00.000Z',
  'medianoche del 26 de marzo en Madrid (CET), no las 22:00Z que daría restar 168 h',
);
assert.strictEqual(
  (rangoDeScope('hoy', new Date('2026-04-02T10:00:00Z'), MADRID).desde!.getTime() -
    semanaMarzo.cerradasDesde!.getTime()) /
    3_600_000,
  167,
  'la semana que cruza el cambio de marzo mide 167 h, no 168',
);

const semanaOctubre = rangoDeScope('agenda', new Date('2026-10-29T10:00:00Z'), MADRID);
assert.strictEqual(
  (rangoDeScope('hoy', new Date('2026-10-29T10:00:00Z'), MADRID).desde!.getTime() -
    semanaOctubre.cerradasDesde!.getTime()) /
    3_600_000,
  169,
  'la de octubre mide 169 h',
);

// Una tarea a las 23:30 del día que dura 23 h sigue siendo de HOY.
assert.strictEqual(
  bucket(tarea('2026-03-29T21:30:00Z'), new Date('2026-03-29T10:00:00Z'), MADRID),
  'hoy',
  '23:30 local del día de la transición es hoy',
);

console.log('crm/tasks.buckets.check OK');
