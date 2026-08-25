// 43 — Ejecutar un sub-flujo: el recorrido del hijo, dentro del paso del padre.
//
// **Por qué inline y no encolado**, que es lo primero que uno intenta: no existe un tercer modo
// de `Salida.esperar` («esperar a que termine otro run») ni despertador para él; un run aparcado
// sin `reanudarEn` ni `caducaEn` es INVISIBLE para el barrido y se queda colgado para siempre; y
// un padre que se quedara `running` esperando sería revivido a los 10 min por silencio y —como
// el paso se graba `ok` DESPUÉS del handler— volvería a lanzar al hijo, o sea a mandar sus
// mensajes dos veces. Las tres puertas están cerradas; queda ésta.
//
// Eso contradice la frase con la que abre el motor («un nodo por job, así el reintento no repite
// lo que ya mandó») y **se paga**: el hijo escribe sus pasos conforme avanza, y un reintento del
// padre lo REANUDA en vez de rearrancarlo. Con la unique `(parentRunId, parentNodeId)` en la
// base, el hijo recupera exactamente la misma idempotencia que el motor, con el mismo mecanismo.
//
// Bucle propio y NO un refactor de `avanzar`: de `avanzar` esto no usa nada —cargar el run,
// reanudar, aparcar, `continuar` + `cola.add`— y lo que sí comparten ya está fuera de los dos
// (`siguienteNodoId`, `interpolarConfig`, `conSalidaYVariable`, `nodeType`). Además `avanzar` no
// tiene check: es el peor sitio del módulo para meter un refactor, y esto sí lo tiene.
//
// Puro salvo por los handlers: la base entra por `Persistencia`, misma costura que `dobles()`.
import { Contexto, conSalidaYVariable } from './contexto';
import { Salida, Servicios, interpolarConfig, nodeType } from './catalog';
import { AristaMin, NodoMin, nodoRaiz, siguienteNodoId } from './graph';

export const MAX_PROFUNDIDAD = 3;
/** Sub-runs del ÁRBOL entero, no por padre: por padre se multiplicarían por nivel. */
export const TOPE_SUBRUNS = 10;
/** Mismo número y mismo motivo que `TOPE_PASOS` en `simulacion.ts`. */
export const TOPE_NODOS = 200;
/**
 * El tope que no se ve, y el más importante de los cuatro.
 *
 * `SIN_SENAL_MS` del barrido son 10 min contra el `updatedAt` del PADRE, y el árbol inline no lo
 * toca. Pasados esos 10 minutos el barrido revive al padre mientras el job original sigue vivo:
 * el revivido encuentra al hijo por la unique, lo reanuda, y hay DOS workers dentro del mismo
 * hijo — dos `message.send` del mismo nodo, porque `registrarPaso` es un `upsert` y no choca.
 * 60 s deja un margen de 10× y aun así permite seis `http.request` seguidos.
 *
 * ponytail: el techo es un sub-flujo legítimamente largo. Camino: latir sobre el `updatedAt` del
 * padre entre nodos del hijo, y entonces esto pasa a ser tiempo de worker y no una carrera.
 */
export const TOPE_TIEMPO_MS = 60_000;

/** La base, por fuera, para que el check corra sin Postgres. */
export interface Persistencia {
  /**
   * El run del hijo para `(parentRunId, parentNodeId)`. Si ya existe se devuelve tal cual —lo
   * que convierte un reintento del padre en una reanudación— y si no, se crea.
   */
  crearOReanudar(datos: {
    tenantId: string;
    automationId: string;
    conversationId: string | null;
    parentRunId: string;
    parentNodeId: string;
    contexto: Contexto;
  }): Promise<{ id: string; status: string; currentNodeId: string | null; context: Contexto }>;
  /** El paso ya registrado de este nodo, para no repetirlo. */
  pasoPrevio(runId: string, nodeId: string): Promise<{ status: string; output: unknown } | null>;
  registrarPaso(
    runId: string,
    nodeId: string,
    status: 'ok' | 'failed' | 'skipped',
    input: unknown,
    output: unknown,
    error: string | null,
  ): Promise<void>;
  /** Adelanta el puntero del hijo, para que un reintento sepa por dónde iba. */
  avanzarPuntero(runId: string, nodeId: string | null, contexto: Contexto): Promise<void>;
  cerrar(runId: string, status: 'done' | 'failed', error: string | null, contexto: Contexto): Promise<void>;
}

/** El grafo de un flujo llamable, tal como lo lee quien ejecuta. */
export interface FlujoEjecutable {
  id: string;
  nombre: string;
  status: string;
  actorUserId: string | null;
  nodes: (NodoMin & { config: unknown })[];
  edges: AristaMin[];
}

/** Lo que se acarrea de un nivel al siguiente. `presupuesto` es UN objeto para todo el árbol. */
export interface Nivel {
  profundidad: number;
  cadena: string[];
  presupuesto: { subRuns: number; nodos: number; hastaMs: number };
}

export interface EntradaSubflujo {
  flujo: FlujoEjecutable;
  tenantId: string;
  /** El del PADRE, nunca el de la automatización hija: llamar a un flujo no puede ser una forma
   *  de hacer lo que el actor no podría hacer directamente. */
  actorUserId: string | null;
  conversationId: string | null;
  parentRunId: string;
  parentNodeId: string;
  /** El contexto sembrado: `mensaje`/`contacto`/`conversacion` del padre y las `vars` que le
   *  pasaron por `argumentos`. Nada más — un sub-flujo cuya conducta dependiera de quién lo
   *  llama no es un procedimiento. */
  contexto: Contexto;
  ajustes: Record<string, string>;
  nivel: Nivel;
  /** Los servicios que verán los nodos del hijo, ya con su propio `flujos` de un nivel más. */
  servicios: Servicios;
  persistencia: Persistencia;
  /** Inyectado para poder afirmar el tope de tiempo en el check sin esperar un minuto. */
  ahora: () => number;
}

export interface ResultadoSubflujo {
  runId: string;
  automationId: string;
  nombre: string;
  status: 'done';
  /** El `vars` del hijo al terminar. Es lo que acaba en `{{vars.<nombre>}}` del padre. */
  vars: Record<string, unknown>;
}

/** Un fallo del sub-flujo que el padre tiene que ver como suyo. */
export class ErrorDeSubflujo extends Error {}

/**
 * Qué impide llamar a este flujo AHORA. Se comprueba antes de tocar la base, para que un rechazo
 * no deje ni una fila ni un efecto.
 *
 * Existe además de la guarda al activar (`llamadas.ts`) porque aquélla **se queda vieja**: dos
 * admins activando a la vez ven cada uno un mundo sin el otro, y un grafo de llamadas legal
 * —A llamando a cien flujos distintos— no es un grafo de llamadas sano. La de activación protege
 * al operador de configurar un disparate; ésta protege al worker de morirse.
 */
export function problemaAntesDeLlamar(flujo: FlujoEjecutable, nivel: Nivel): string | null {
  if (nivel.cadena.includes(flujo.id)) {
    return `«${flujo.nombre}» ya está en la cadena de llamadas: eso sería un bucle.`;
  }
  if (nivel.profundidad + 1 > MAX_PROFUNDIDAD) {
    return `La cadena de llamadas pasa de ${MAX_PROFUNDIDAD} niveles al llamar a «${flujo.nombre}».`;
  }
  if (nivel.presupuesto.subRuns + 1 > TOPE_SUBRUNS) {
    return `Esta ejecución ya llamó a ${TOPE_SUBRUNS} flujos, que es el máximo.`;
  }
  if (flujo.status !== 'active') {
    return `«${flujo.nombre}» está en borrador: un flujo a medio escribir no se ejecuta desde otro.`;
  }
  return null;
}

/**
 * Recorre el grafo del hijo hasta el final y devuelve su `vars`.
 *
 * Lanza `ErrorDeSubflujo` si algo lo impide. El padre lo deja subir: su paso queda `failed`,
 * BullMQ reintenta, y al agotarse el run del padre muere con el motivo escrito. Nada de una rama
 * de error ni de seguir con un resultado a medias — un hijo que falló ya hizo la mitad de sus
 * efectos, y continuar con eso es la mentira por optimismo que este módulo rechaza.
 */
export async function ejecutarSubflujo(e: EntradaSubflujo): Promise<ResultadoSubflujo> {
  const problema = problemaAntesDeLlamar(e.flujo, e.nivel);
  if (problema) throw new ErrorDeSubflujo(problema);

  const persistencia = e.persistencia;
  e.nivel.presupuesto.subRuns += 1;

  const hijo = await persistencia.crearOReanudar({
    tenantId: e.tenantId,
    automationId: e.flujo.id,
    conversationId: e.conversationId,
    parentRunId: e.parentRunId,
    parentNodeId: e.parentNodeId,
    contexto: e.contexto,
  });

  // Ya terminó: un reintento del padre no vuelve a ejecutar nada. Es el caso que la unique
  // `(parentRunId, parentNodeId)` existe para dar.
  if (hijo.status === 'done') {
    return {
      runId: hijo.id,
      automationId: e.flujo.id,
      nombre: e.flujo.nombre,
      status: 'done',
      vars: ((hijo.context ?? {}).vars ?? {}) as Record<string, unknown>,
    };
  }

  const { nodes, edges } = e.flujo;
  // Se reanuda por donde iba, igual que `avanzar` con `currentNodeId`.
  let nodo: (NodoMin & { config: unknown }) | null = hijo.currentNodeId
    ? (nodes.find((n) => n.id === hijo.currentNodeId) ?? null)
    : nodoRaiz(nodes);
  let ctx: Contexto = (hijo.context ?? e.contexto) as Contexto;

  const seguir = (desdeId: string, rama: string | null) => {
    const id = siguienteNodoId(edges, desdeId, rama);
    return id ? (nodes.find((n) => n.id === id) ?? null) : null;
  };

  while (nodo) {
    if (e.ahora() > e.nivel.presupuesto.hastaMs) {
      throw new ErrorDeSubflujo(
        `«${e.flujo.nombre}» tardó demasiado (más de ${TOPE_TIEMPO_MS / 1000} s en total). Un sub-flujo es una llamada, no un proceso largo.`,
      );
    }
    if (e.nivel.presupuesto.nodos + 1 > TOPE_NODOS) {
      throw new ErrorDeSubflujo(`Esta ejecución pasó de ${TOPE_NODOS} pasos entre todos sus flujos.`);
    }
    e.nivel.presupuesto.nodos += 1;

    const actual = nodo;
    const tipo = nodeType(actual.type);

    // ponytail: el atajo del trigger («no se ejecuta, pero SÍ tiene salida: la carga que trajo
    // el disparo») queda en tres copias de cuatro líneas — aquí, en `avanzar` y en `simular`.
    // Techo: si esa regla cambia, hay tres sitios. Camino: una función en `catalog.ts` el día
    // que sean cuatro.
    if (!tipo?.handler) {
      const carga = (ctx.disparador ?? null) as unknown;
      await persistencia.registrarPaso(hijo.id, actual.id, 'skipped', null, carga, null);
      ctx = conSalidaYVariable(ctx, actual, carga);
      nodo = seguir(actual.id, null);
      await persistencia.avanzarPuntero(hijo.id, nodo?.id ?? null, ctx);
      continue;
    }

    // Misma idempotencia que el motor, y por el mismo motivo: si este paso ya salió bien, un
    // reintento no puede volver a mandar su mensaje. La rama sale de la salida guardada, no de
    // la por defecto — reencaminar por la otra sería mandarle otra cosa al cliente.
    const previo = await persistencia.pasoPrevio(hijo.id, actual.id);
    if (previo?.status === 'ok') {
      const rama = (previo.output as { rama?: string | null } | null)?.rama ?? null;
      ctx = conSalidaYVariable(ctx, actual, previo.output ?? null);
      nodo = seguir(actual.id, rama);
      await persistencia.avanzarPuntero(hijo.id, nodo?.id ?? null, ctx);
      continue;
    }

    const contextoNodo = { ...ctx, ajustes: e.ajustes };
    const config = interpolarConfig(tipo, actual.config, contextoNodo);

    let salida: Salida;
    try {
      salida = await tipo.handler(config, {
        tenantId: e.tenantId,
        actorUserId: e.actorUserId,
        conversationId: e.conversationId,
        nodeId: actual.id,
        contexto: contextoNodo,
        servicios: e.servicios,
      });
    } catch (err) {
      const motivo = (err as Error)?.message ?? 'Error desconocido';
      // El paso queda `failed` y el hijo se deja SIN cerrar: así el reintento del padre lo
      // reanuda por este mismo nodo en vez de rearrancarlo desde el principio.
      await persistencia.registrarPaso(hijo.id, actual.id, 'failed', actual.config, null, motivo);
      throw new ErrorDeSubflujo(`«${e.flujo.nombre}» falló en «${tipo.label}»: ${motivo}`);
    }

    // Por ESTRUCTURA y no por el flag del catálogo: coge `ms` y `entrada` a la vez, y coge un
    // nodo futuro que espere aunque se olvidaran de declararlo. Mismo idioma que usa el motor
    // para encontrar la rama de caducidad.
    //
    // Es alcanzable de verdad pese a las dos guardas de antes: B se edita —lo que la baja a
    // borrador—, se le mete un `wait.reply`, y B se REACTIVA. La activación de B valida el
    // grafo desde B, y B no sabe quién la llama.
    if (salida.esperar) {
      await persistencia.registrarPaso(hijo.id, actual.id, 'failed', actual.config, null, 'Un sub-flujo no puede esperar.');
      throw new ErrorDeSubflujo(
        `«${e.flujo.nombre}» tiene un nodo de espera («${tipo.label}») y una llamada no puede esperar. Quítalo de «${e.flujo.nombre}», o úsala como flujo principal.`,
      );
    }

    // La config CRUDA en el paso, como el motor y al revés que la simulación: aquí es un run de
    // verdad y su historial tiene que leerse igual que el de cualquier otro.
    await persistencia.registrarPaso(hijo.id, actual.id, 'ok', actual.config, salida.output ?? null, null);
    ctx = conSalidaYVariable(ctx, actual, salida.output ?? null);
    nodo = seguir(actual.id, salida.branch ?? null);
    await persistencia.avanzarPuntero(hijo.id, nodo?.id ?? null, ctx);
  }

  await persistencia.cerrar(hijo.id, 'done', null, ctx);
  return {
    runId: hijo.id,
    automationId: e.flujo.id,
    nombre: e.flujo.nombre,
    status: 'done',
    vars: (ctx.vars ?? {}) as Record<string, unknown>,
  };
}
