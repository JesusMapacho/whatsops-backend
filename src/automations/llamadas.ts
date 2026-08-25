// 43 — El grafo de llamadas ENTRE automatizaciones: qué flujo puede llamar a cuál.
//
// Puro (ver llamadas.check.ts). Decide, no ejecuta: la consulta que arma el mapa vive en el
// servicio, igual que `barrido.ts` decide y el processor obra, y que `metricas.ts` arma y el
// servicio consulta.
//
// **Por qué no se extiende `problemasDelGrafo`**, que es donde la spec lo puso: esa función es
// pura sobre `(nodos, aristas)` de UN grafo y ni siquiera conoce el id de su propia
// automatización. Lo de aquí necesita conocer a las demás, o sea la base. Meterle una consulta
// dentro la convertiría en lo contrario de lo que es, y es la única pieza que hoy decide el
// orden en que se le hacen cosas a un cliente sin tocar Postgres.
import { TIPO_LLAMADA, idDeLlamada } from './catalog';

/** Lo que hace falta saber de cada automatización del negocio para decidir. */
export interface FlujoConocido {
  nombre: string;
  /** `active` o `draft`. Un borrador no se puede llamar: es un flujo a medio escribir. */
  status: string;
  /** A quién llama, ya extraído de sus nodos. */
  llama: string[];
  /** Tiene algún nodo que espera. Un sub-flujo es un procedimiento, no una conversación. */
  espera: boolean;
}

/** Tres niveles ya son más composición de la que nadie dibuja. Ver `subflujo.ts`. */
export const MAX_PROFUNDIDAD = 3;

/** Los ids a los que llama un grafo. Ignora todo lo que no sea el nodo de llamada. */
export function idsLlamados(nodos: { type: string; config: unknown }[]): string[] {
  const out: string[] = [];
  for (const n of nodos) {
    if (n.type !== TIPO_LLAMADA) continue;
    const id = idDeLlamada(n.config);
    // Sin repetidos: llamar dos veces al mismo flujo desde el mismo grafo es legal, y para
    // decidir ciclos y profundidad da igual cuántas veces.
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Qué impide activar este grafo, mirando a quién llama. Mensajes en castellano, para pintarlos
 * tal cual en el editor — misma forma que `problemasDelGrafo` y `problemasDeFunciones`, así que
 * el servicio los concatena y no aprende nada nuevo.
 *
 * `flujos` trae SOLO las automatizaciones del mismo tenant. El alcance se aplica en el `where`
 * de quien consulta, nunca aquí: un `if` de tenant en una función pura es un alcance que se
 * puede olvidar de pasar.
 */
export function problemasDeLlamadas(
  propiaId: string,
  propiaLlama: string[],
  flujos: Map<string, FlujoConocido>,
): string[] {
  const out: string[] = [];
  const nombre = (id: string) => flujos.get(id)?.nombre ?? id;

  for (const id of propiaLlama) {
    if (id === propiaId) {
      out.push('Esta automatización se llama a sí misma, y eso no se puede ejecutar.');
      continue;
    }
    const f = flujos.get(id);
    // No está o no es del tenant: para quien llama son el mismo problema, y decir «no existe»
    // de algo que sí existe en otro negocio sería filtrar que existe.
    if (!f) {
      out.push('Uno de los nodos «Ejecutar flujo» apunta a una automatización que ya no existe.');
      continue;
    }
    if (f.status !== 'active') {
      out.push(`«${f.nombre}» está en borrador: actívala antes de llamarla desde aquí.`);
    }
    if (f.espera) {
      out.push(`«${f.nombre}» tiene un nodo de espera, y una llamada no puede esperar. Quítalo, o úsala como flujo principal.`);
    }
  }

  // El ciclo se busca DESDE esta automatización, con ella ya dentro del camino: así
  // `A → B → A` se detecta al activar A y también al activar B, que es lo que hace falta —
  // cada activación es la única oportunidad de pararlo desde ese lado.
  const ciclo = buscarCiclo(propiaId, propiaLlama, flujos, [propiaId]);
  if (ciclo) {
    out.push(`Esto haría un bucle de llamadas: ${ciclo.map(nombre).join(' → ')}. Un flujo no puede acabar llamándose a sí mismo.`);
  }

  // La profundidad se mide aparte del ciclo: un grafo de llamadas puede ser perfectamente
  // acíclico y aun así demasiado hondo, y son dos problemas con dos mensajes distintos.
  const hondo = profundidad(propiaLlama, flujos, 1, new Set([propiaId]));
  if (hondo > MAX_PROFUNDIDAD) {
    out.push(`La cadena de llamadas baja ${hondo} niveles y el máximo es ${MAX_PROFUNDIDAD}. Aplana alguno de los flujos.`);
  }

  return out;
}

/** El camino del ciclo, para poder nombrarlo. `null` si no hay. */
function buscarCiclo(
  raiz: string,
  desde: string[],
  flujos: Map<string, FlujoConocido>,
  camino: string[],
): string[] | null {
  for (const id of desde) {
    if (id === raiz) return [...camino, id];
    // Ya visitado en ESTE camino: hay un ciclo, pero uno que no pasa por la raíz. No es
    // problema de esta activación —lo será de la suya— y seguir bajando por él no termina.
    if (camino.includes(id)) continue;
    const f = flujos.get(id);
    if (!f) continue;
    const hallado = buscarCiclo(raiz, f.llama, flujos, [...camino, id]);
    if (hallado) return hallado;
  }
  return null;
}

/**
 * Cuántos niveles baja la cadena por debajo de quien pregunta. `vistos` corta los ciclos, que
 * los reporta `buscarCiclo` con su propio mensaje.
 *
 * `nivel - 1` cuando no hay a dónde bajar, y no `nivel`: el que se está evaluando ya se contó
 * en la llamada de arriba. Contarlo dos veces daba 4 para `A → B → C → D`, que son 3.
 */
function profundidad(desde: string[], flujos: Map<string, FlujoConocido>, nivel: number, vistos: Set<string>): number {
  let max = nivel - 1;
  for (const id of desde) {
    if (vistos.has(id)) continue;
    const f = flujos.get(id);
    // Un id que no está cuenta como un nivel igual: sigue siendo una llamada, solo que rota, y
    // ya tiene su propio mensaje. No contarla haría que un grafo hondo con una llamada muerta
    // en medio pareciera más corto de lo que es.
    max = Math.max(max, f ? profundidad(f.llama, flujos, nivel + 1, new Set([...vistos, id])) : nivel);
  }
  return max;
}
