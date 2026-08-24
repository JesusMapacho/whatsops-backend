// Check de los números de la lista de automatizaciones.
// Correr: npx ts-node src/automations/metricas.check.ts
import * as assert from 'node:assert';
import { armar, DIAS_DEF, DIAS_MAX, FilaCubo, parseDias, ventana, zonaValida } from './metricas';

const MX = 'America/Mexico_City'; // UTC-6 fijo, sin horario de verano desde 2022
const MADRID = 'Europe/Madrid'; // UTC+1 / UTC+2: aquí sí hay transiciones

// --- parseDias ------------------------------------------------------------------------
// Nada, vacío o basura → el default. No un 400: la pantalla manda un número de un
// desplegable suyo, así que un valor raro es un bug del cliente o alguien tecleando la URL,
// y en los dos casos siete días es mejor respuesta que un error.
assert.strictEqual(parseDias(undefined), DIAS_DEF);
assert.strictEqual(parseDias(''), DIAS_DEF);
assert.strictEqual(parseDias('abc'), DIAS_DEF);
assert.strictEqual(parseDias(null), DIAS_DEF);
// Cero y negativos también al default, igual que `Number(limit) || 20` en `runs()`: una
// ventana de cero días no es una respuesta, es una pantalla en blanco.
assert.strictEqual(parseDias('0'), DIAS_DEF, 'cero es el default, no una ventana vacía');
assert.strictEqual(parseDias('-3'), DIAS_DEF);
// Los dos bordes del rango útil.
assert.strictEqual(parseDias('1'), 1);
assert.strictEqual(parseDias(String(DIAS_MAX)), DIAS_MAX);
assert.strictEqual(parseDias(String(DIAS_MAX + 1)), DIAS_MAX, 'se acota, no se rechaza');
assert.strictEqual(parseDias('9999'), DIAS_MAX);
assert.strictEqual(parseDias('7.9'), 7, 'se trunca, no se redondea');

// --- zonaValida -----------------------------------------------------------------------
// Los dos lados del cálculo tienen que usar la MISMA zona: `diaEn` cae a UTC sola ante una
// zona inválida, pero el `AT TIME ZONE` de Postgres con esa misma basura lanza. Si no se
// validara aquí, una zona rota daría una serie cortada con una zona y etiquetada con otra.
assert.strictEqual(zonaValida(MX), MX);
assert.strictEqual(zonaValida(null), 'UTC');
assert.strictEqual(zonaValida(undefined), 'UTC');
assert.strictEqual(zonaValida(''), 'UTC', 'la cadena vacía no es una zona');
assert.strictEqual(zonaValida('Marte/Olympus'), 'UTC');
// Y lo que de verdad importa: nunca sale algo que Postgres no pueda interpretar.
assert.doesNotThrow(() => zonaValida("'; DROP TABLE --"));
assert.strictEqual(zonaValida("'; DROP TABLE --"), 'UTC');

// --- ventana --------------------------------------------------------------------------
// Ayuda: los días de una ventana tienen que ser consecutivos, sin repetir ni saltar. Es lo
// que se rompe si alguien «simplifica» el retroceso a un `-24h`.
function consecutivos(claves: string[]): boolean {
  for (let i = 1; i < claves.length; i++) {
    const [y, m, d] = claves[i - 1].split('-').map(Number);
    const siguiente = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    if (claves[i] !== siguiente) return false;
  }
  return true;
}

// EL caso que motiva toda la zona horaria: las 02:00 UTC del 12 son todavía el 11 en México,
// así que la ventana termina el 11. Con la hora del servidor, «hoy» empezaría a las 18:00 de
// la tarde anterior y el dueño del negocio vería las ejecuciones de hoy en la barra de mañana.
const V = ventana(new Date('2026-08-12T02:00:00Z'), 7, MX);
assert.strictEqual(V.claves.length, 7);
assert.strictEqual(V.claves.at(-1), '2026-08-11', 'el último cubo es HOY en la zona del negocio');
assert.strictEqual(V.claves[0], '2026-08-05', 'y el primero, seis días antes');
assert.ok(consecutivos(V.claves));
// `desde` es la medianoche del más antiguo; en México (UTC-6), las 06:00 UTC.
assert.strictEqual(V.desde.toISOString(), '2026-08-05T06:00:00.000Z');
// En UTC el mismo instante cae ya en el 12, y la ventana entera se corre un día.
assert.strictEqual(ventana(new Date('2026-08-12T02:00:00Z'), 7, 'UTC').claves.at(-1), '2026-08-12');

// Un solo día: la ventana es hoy, y `desde` su medianoche.
const UNO = ventana(new Date('2026-08-12T02:00:00Z'), 1, MX);
assert.deepStrictEqual(UNO.claves, ['2026-08-11']);
assert.strictEqual(UNO.desde.toISOString(), '2026-08-11T06:00:00.000Z');

// El tope: 30 días siguen siendo 30 fechas consecutivas.
const MAXV = ventana(new Date('2026-08-12T02:00:00Z'), DIAS_MAX, MX);
assert.strictEqual(MAXV.claves.length, DIAS_MAX);
assert.ok(consecutivos(MAXV.claves));

// --- ventana y el horario de verano ---------------------------------------------------
// El 25 de octubre de 2026 Madrid atrasa el reloj: ese día dura 25 horas. Una ventana que lo
// cruza es donde un `-24h` a pelo repetiría una fecha.
const OTONO = ventana(new Date('2026-10-27T12:00:00Z'), 7, MADRID);
assert.strictEqual(OTONO.claves.length, 7);
assert.ok(consecutivos(OTONO.claves), 'el día de 25 h no repite ni salta fecha');
assert.ok(OTONO.claves.includes('2026-10-25'), 'y el día del cambio está dentro de la ventana');
// El 29 de marzo el reloj se adelanta y el día dura 23 horas: el mismo riesgo al revés.
const PRIMAVERA = ventana(new Date('2026-03-31T12:00:00Z'), 7, MADRID);
assert.strictEqual(PRIMAVERA.claves.length, 7);
assert.ok(consecutivos(PRIMAVERA.claves), 'el día de 23 h tampoco');
assert.ok(PRIMAVERA.claves.includes('2026-03-29'));

// Zona nula (tenant sin onboarding terminado) y zona basura → UTC, no una excepción. Una
// pantalla de automatizaciones no puede caerse porque alguien tecleó mal su país.
assert.strictEqual(ventana(new Date('2026-08-12T02:00:00Z'), 3, null).claves.at(-1), '2026-08-12');
assert.strictEqual(
  ventana(new Date('2026-08-12T02:00:00Z'), 3, 'Marte/Olympus').claves.at(-1),
  '2026-08-12',
);

// --- armar ----------------------------------------------------------------------------
const CLAVES = ['2026-08-09', '2026-08-10', '2026-08-11'];
const fila = (automationId: string, dia: string, status: string, n: number): FilaCubo => ({
  automationId,
  dia,
  status,
  n,
});

// Un flujo que NUNCA corrió sale igual, con ceros y `null`. Si faltara la fila, el frontend
// tendría que distinguir «no corrió» de «no llegó el dato», que es justo la mentira que su
// pantalla de carga existe para evitar.
const vacio = armar(['a'], [], CLAVES, new Map());
assert.deepStrictEqual(vacio, [
  { automationId: 'a', serie: [0, 0, 0], ok: 0, fallidas: 0, cortadas: 0, ultimaEjecucion: null },
]);

// Los tres estados terminales, cada uno a su contador, y todos al sparkline.
const term = armar(
  ['a'],
  [
    fila('a', '2026-08-09', 'done', 3),
    fila('a', '2026-08-11', 'failed', 2),
    fila('a', '2026-08-11', 'cortado', 1),
  ],
  CLAVES,
  new Map(),
)[0];
assert.deepStrictEqual(term.serie, [3, 0, 3], 'el día de en medio sin runs es un 0, no un hueco');
assert.strictEqual(term.ok, 3);
assert.strictEqual(term.fallidas, 2);
assert.strictEqual(term.cortadas, 1);

// LA decisión que hay que poder afirmar: `running` y `waiting` van al sparkline pero NO a los
// contadores. Son ejecuciones que pasaron, pero todavía no son ni un éxito ni un fallo, así
// que meterlas en la tasa la haría bajar sola mientras un flujo trabaja.
const vuelo = armar(
  ['a'],
  [
    fila('a', '2026-08-11', 'done', 2),
    fila('a', '2026-08-11', 'running', 3),
    fila('a', '2026-08-11', 'waiting', 1),
  ],
  CLAVES,
  new Map(),
)[0];
assert.deepStrictEqual(vuelo.serie, [0, 0, 6]);
assert.strictEqual(vuelo.ok + vuelo.fallidas + vuelo.cortadas, 2);
const suma = vuelo.serie.reduce((s, n) => s + n, 0);
assert.ok(
  suma > vuelo.ok + vuelo.fallidas + vuelo.cortadas,
  'con runs en vuelo sum(serie) es MAYOR que ok+fallidas+cortadas, y eso es correcto',
);

// Un estado que no conoce cuenta en la serie y en ninguna otra parte, sin lanzar: el enum de
// Postgres puede crecer y eso no puede tumbar la pantalla.
const raro = armar(['a'], [fila('a', '2026-08-10', 'inventado', 4)], CLAVES, new Map())[0];
assert.deepStrictEqual(raro.serie, [0, 4, 0]);
assert.strictEqual(raro.ok + raro.fallidas + raro.cortadas, 0);

// `ultimaEjecucion` es ISO y viene de fuera de la ventana a propósito: `null` quiere decir
// «nunca corrió», no «no corrió esta semana».
const vieja = new Date('2026-01-02T03:04:05.000Z');
const conUltima = armar(['a', 'b'], [], CLAVES, new Map([['a', vieja]]));
assert.strictEqual(conUltima[0].ultimaEjecucion, '2026-01-02T03:04:05.000Z');
assert.deepStrictEqual(conUltima[0].serie, [0, 0, 0], 'fuera de la ventana no suma al sparkline');
assert.strictEqual(conUltima[1].ultimaEjecucion, null);

// El orden de la salida es el de `automationIds`, que es el que ya trae `GET /automations`.
assert.deepStrictEqual(
  armar(['c', 'a', 'b'], [], CLAVES, new Map()).map((f) => f.automationId),
  ['c', 'a', 'b'],
);

// EL FILO DEL AISLAMIENTO en esta capa: una fila de un flujo que no está en la lista se
// descarta, no se inventa una entrada. La lista viene ya acotada por `tenantId`, así que esto
// es lo que impide que un flujo ajeno aparezca si alguna vez la consulta de arriba se
// escribe mal.
const ajeno = armar(['a'], [fila('otro-tenant', '2026-08-11', 'done', 9)], CLAVES, new Map());
assert.strictEqual(ajeno.length, 1);
assert.strictEqual(ajeno[0].automationId, 'a');
assert.deepStrictEqual(ajeno[0].serie, [0, 0, 0]);
assert.strictEqual(ajeno[0].ok, 0, 'los conteos de otro tenant tampoco se suman en ninguna parte');

// Un día fuera de la ventana tampoco entra, ni por la serie ni por los contadores.
const fuera = armar(['a'], [fila('a', '2026-08-01', 'done', 5)], CLAVES, new Map())[0];
assert.deepStrictEqual(fuera.serie, [0, 0, 0]);
assert.strictEqual(fuera.ok, 0);

// Varias filas del mismo día y estado se suman en vez de pisarse.
const sumadas = armar(
  ['a'],
  [fila('a', '2026-08-11', 'done', 2), fila('a', '2026-08-11', 'done', 3)],
  CLAVES,
  new Map(),
)[0];
assert.strictEqual(sumadas.ok, 5);
assert.deepStrictEqual(sumadas.serie, [0, 0, 5]);

console.log('metricas.check OK');
