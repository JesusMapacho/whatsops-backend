// Check del barrido (v11 feature 41). Correr: npx ts-node src/check-all.ts
//
// Los asserts que importan son los de los BORDES. La feature entera existe porque el motor se
// colgaba en silencio; un barrido con el umbral mal puesto cambia «se cuelga» por «mata runs
// que iban bien», que es peor porque además parece que funciona.
import * as assert from 'node:assert';
import {
  MARGEN_REANUDAR_MS,
  MAX_REVIVIDOS,
  SIN_SENAL_MS,
  queHacerCon,
} from './barrido';

const AHORA = new Date('2026-08-21T12:00:00.000Z');
const haceMs = (ms: number) => new Date(AHORA.getTime() - ms);
const enMs = (ms: number) => new Date(AHORA.getTime() + ms);

/** Un run vivo cualquiera; cada assert cambia solo lo suyo. */
const run = (x: Partial<Parameters<typeof queHacerCon>[0]>) =>
  queHacerCon(
    { status: 'running', updatedAt: AHORA, reanudarEn: null, caducaEn: null, vecesRevivido: 0, esHijo: false, ...x },
    AHORA,
  );

// --- `running`: alguien está trabajando en esto, ¿o murió? -------------------------------

assert.strictEqual(run({ updatedAt: AHORA }), 'nada', 'acabado de tocar: está vivo');
assert.strictEqual(run({ updatedAt: haceMs(1000) }), 'nada', 'un segundo es un nodo trabajando');
assert.strictEqual(
  run({ updatedAt: haceMs(30_000) }),
  'nada',
  'medio minuto tampoco: un `http.request` puede tardar sus 10 s',
);
// El borde exacto, en los dos lados. Si alguien baja este umbral, aquí se enterará.
assert.strictEqual(run({ updatedAt: haceMs(SIN_SENAL_MS) }), 'nada', 'justo en el umbral, todavía no');
assert.strictEqual(run({ updatedAt: haceMs(SIN_SENAL_MS + 1) }), 'revivir', 'un ms más, y está muerto');

// --- El tope de intentos: revivir es seguro, pero no infinito ----------------------------

for (let n = 0; n < MAX_REVIVIDOS; n++) {
  assert.strictEqual(
    run({ updatedAt: haceMs(SIN_SENAL_MS + 1), vecesRevivido: n }),
    'revivir',
    `con ${n} intentos gastados todavía se intenta`,
  );
}
assert.strictEqual(
  run({ updatedAt: haceMs(SIN_SENAL_MS + 1), vecesRevivido: MAX_REVIVIDOS }),
  'cortar',
  'gastados los tres, fuera: un run que muere siempre se re-encolaría en bucle',
);
assert.strictEqual(
  run({ updatedAt: haceMs(SIN_SENAL_MS + 1), vecesRevivido: 99, esHijo: false }),
  'cortar',
  'y por encima del tope, igual',
);

// --- `waiting` esperando RESPUESTA: la caducidad ------------------------------------------

const esperando = (x: Partial<Parameters<typeof queHacerCon>[0]>) =>
  run({ status: 'waiting', updatedAt: haceMs(30 * 24 * 3600_000), ...x });

assert.strictEqual(
  esperando({ caducaEn: enMs(3600_000) }),
  'nada',
  'aún le queda paciencia, aunque lleve un mes parado: aparcado NO es colgado',
);
assert.strictEqual(esperando({ caducaEn: AHORA }), 'sin-respuesta', 'justo al caducar, ya');
assert.strictEqual(esperando({ caducaEn: haceMs(1) }), 'sin-respuesta');
assert.strictEqual(
  esperando({ caducaEn: null }),
  'nada',
  'sin caducidad no se toca: es un run guardado antes de esta feature',
);

// Ese `updatedAt` de hace un mes es el assert importante de todo el archivo: un run APARCADO
// no tiene señal de vida y no debe confundirse con uno muerto. Es exactamente por esto que
// `wait.delay` deja de quedarse en `running`.
assert.strictEqual(
  esperando({ caducaEn: enMs(1) }),
  'nada',
  'un run aparcado un mes NO es un zombi: el umbral de señal solo aplica a `running`',
);

// --- `waiting` esperando una HORA: el job perdido ----------------------------------------

assert.strictEqual(esperando({ reanudarEn: enMs(3600_000) }), 'nada', 'todavía no le toca');
assert.strictEqual(esperando({ reanudarEn: AHORA }), 'nada', 'le toca ahora: que lo despierte su job');
assert.strictEqual(
  esperando({ reanudarEn: haceMs(MARGEN_REANUDAR_MS) }),
  'nada',
  'dentro del margen de cortesía, BullMQ puede estar a punto',
);
assert.strictEqual(
  esperando({ reanudarEn: haceMs(MARGEN_REANUDAR_MS + 1) }),
  'revivir',
  'pasado el margen su job se perdió (Redis vaciado): se repone, como `reponerCrons`',
);
// Y no gasta intento, porque no murió nada: se vació la cache.
assert.strictEqual(
  esperando({ reanudarEn: haceMs(MARGEN_REANUDAR_MS + 1), vecesRevivido: MAX_REVIVIDOS }),
  'revivir',
  'reponer un job perdido no consume el tope de reintentos',
);

// Si conviven las dos —no debería, pero los datos mandan menos que una regla escrita— gana la
// caducidad: de nada sirve despertar a un run al que ya se le pasó el arroz.
assert.strictEqual(
  esperando({ caducaEn: haceMs(1), reanudarEn: haceMs(MARGEN_REANUDAR_MS + 1) }),
  'sin-respuesta',
  'la paciencia manda sobre el despertador',
);

// --- Los terminados no se resucitan -------------------------------------------------------

for (const status of ['done', 'failed', 'cortado']) {
  assert.strictEqual(
    run({ status, updatedAt: haceMs(365 * 24 * 3600_000), caducaEn: haceMs(1), reanudarEn: haceMs(1) }),
    'nada',
    `${status} está terminado: el barrido no lo toca por viejo que sea`,
  );
}
assert.strictEqual(run({ status: 'inventado', updatedAt: haceMs(1e9) }), 'nada', 'un estado que no conoce, quieto');


// --- Un HIJO nunca se revive suelto (43) -------------------------------------------------
// Es la guarda que sostiene la composición entera: el árbol vive dentro de UN job y la cadena
// de llamadas viaja en su pila. Revivir a un hijo por su cuenta lo sacaría del árbol —sin
// profundidad, sin presupuesto, sin cadena— y, si el padre sigue vivo, habría dos workers
// dentro del mismo hijo mandando el mismo mensaje.
{
  const muerto = { status: 'running', updatedAt: haceMs(SIN_SENAL_MS + 1000), reanudarEn: null, caducaEn: null, vecesRevivido: 0, esHijo: true };
  assert.strictEqual(queHacerCon(muerto, AHORA), 'cortar', 'un hijo sin señal se corta, no se revive');
  // El MISMO run como primer nivel da lo contrario: ahí revivir es lo correcto. Es lo que fija
  // que la diferencia la hace el parentesco y no otra cosa del fixture.
  assert.strictEqual(queHacerCon({ ...muerto, esHijo: false }, AHORA), 'revivir');

  // Con señal reciente se deja en paz: su padre está trabajando dentro de él ahora mismo.
  assert.strictEqual(queHacerCon({ ...muerto, updatedAt: haceMs(1000) }, AHORA), 'nada');

  // Un hijo no debería poder estar aparcado —un sub-flujo no espera— pero si aparece uno, no se
  // toca: reanimarlo sería inventarle un padre.
  assert.strictEqual(queHacerCon({ ...muerto, status: 'waiting', reanudarEn: haceMs(999999) }, AHORA), 'nada');
}

console.log('barrido.check OK');
