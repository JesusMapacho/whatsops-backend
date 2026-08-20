// Qué hacer con un run que se quedó a medias (v11 feature 41). Puro: ver barrido.check.ts.
//
// Existe porque el motor **se cuelga** y no había forma de enterarse. Cuatro caminos dejaban
// un run vivo para siempre —una excepción fuera del `try` del handler, un `cola.add` que falla,
// un job que pasa `maxStalledCount`, Redis vaciado durante una espera— y ninguno tenía barrido,
// ni evento de BullMQ, ni endpoint para desbloquear. La única salida era borrar la
// automatización o un UPDATE a mano.
//
// La decisión vive aquí y no dentro del barrido de la cola por un motivo concreto: es la parte
// que tiene bordes (¿a los diez minutos o a los once?, ¿al tercer intento o al cuarto?) y no
// debería hacer falta una base de datos ni un worker para comprobarlos.

/**
 * `revivir` re-encolar y seguir donde iba · `cortar` cerrarlo, ya no se puede salvar ·
 * `sin-respuesta` el cliente no contestó: seguir por esa rama · `nada` está bien como está.
 */
export type Accion = 'revivir' | 'cortar' | 'sin-respuesta' | 'nada';

/** Lo mínimo que el barrido necesita saber de un run. */
export interface RunParaBarrer {
  status: string;
  /** Última señal de vida. El motor la toca en cada paso. */
  updatedAt: Date;
  /** Cuándo tiene que despertar, si está aparcado por tiempo. */
  reanudarEn: Date | null;
  /** Cuándo se le acaba la paciencia, si está esperando que contesten. */
  caducaEn: Date | null;
  vecesRevivido: number;
}

/**
 * Sin señal durante esto = nadie está trabajando en él.
 *
 * Diez minutos es holgado a propósito. El nodo legítimo más lento es `http.request`, que ya
 * corta a los 10 s con su `AbortController`, y `code.run`, que topa en 1 s. Por debajo incluso
 * del `lockDuration` de 30 s de BullMQ, así que un `running` de diez minutos no es lento: está
 * muerto.
 */
export const SIN_SENAL_MS = 10 * 60 * 1000;

/**
 * Cuánta cortesía se le da a un job con `delay` antes de darlo por perdido. Un minuto: BullMQ
 * despierta con precisión de segundos, así que un retraso de un minuto ya no es retraso.
 */
export const MARGEN_REANUDAR_MS = 60 * 1000;

/**
 * Reintentos del barrido antes de rendirse. Revivir es seguro —la unique `(runId, nodeId)`
 * impide repetir un paso, así que un mensaje no sale dos veces— pero sin tope, un run que
 * muere siempre se re-encolaría en bucle para siempre.
 */
export const MAX_REVIVIDOS = 3;

/** Qué hacer con este run, ahora. No toca nada: solo decide. */
export function queHacerCon(run: RunParaBarrer, ahora: Date): Accion {
  const t = ahora.getTime();

  if (run.status === 'running') {
    // Se compara contra `updatedAt`, y eso da el frenado gratis: revivir es un UPDATE, así que
    // el run recién revivido no vuelve a mirarse hasta pasados otros diez minutos.
    if (t - run.updatedAt.getTime() <= SIN_SENAL_MS) return 'nada';
    return run.vecesRevivido < MAX_REVIVIDOS ? 'revivir' : 'cortar';
  }

  if (run.status === 'waiting') {
    // La caducidad primero: si a un run le toca despertar Y se le acabó la paciencia, manda la
    // paciencia. Los dos campos no deberían convivir (uno es esperar respuesta y el otro
    // esperar una hora), pero el orden lo deja decidido en vez de a merced de los datos.
    //
    // `<=` aquí y `<` en el margen de abajo, y la asimetría es a propósito: una caducidad es
    // un plazo —cumplido el plazo, se cumplió— y el margen es cortesía, así que se concede
    // entero. Los dos umbrales quedan igual de conservadores: solo actúan pasándose.
    if (run.caducaEn && run.caducaEn.getTime() <= t) return 'sin-respuesta';
    // Aparcado por tiempo y ya pasó su hora con margen: su job de Redis se perdió. Es el
    // `reponerCrons` de los runs, y no gasta intento porque no murió nada — se vació la cache.
    if (run.reanudarEn && run.reanudarEn.getTime() + MARGEN_REANUDAR_MS < t) return 'revivir';
    return 'nada';
  }

  // `done`, `failed`, `cortado`: terminados. El barrido no resucita a nadie.
  return 'nada';
}
