// El enrutado del grafo (v3 features 17-18): qué nodo va después. Puro (ver graph.check.ts).
//
// Vive aparte del processor porque es lo único que decide el orden en que se le hacen cosas
// a un cliente, y eso tiene que poder comprobarse sin base de datos ni cola.

export interface NodoMin {
  id: string;
  type: string;
  isRoot: boolean;
}

export interface AristaMin {
  fromNodeId: string;
  toNodeId: string;
  branch: string | null;
}

/** El nodo por el que empieza el run. Genérico para devolver la fila entera (con su
 *  `config`) cuando quien llama le pasa nodos de Prisma, no solo lo que este módulo mira. */
export function nodoRaiz<T extends NodoMin>(nodos: T[]): T | null {
  return nodos.find((n) => n.isRoot) ?? null;
}

/**
 * Siguiente nodo desde `desdeId` para la rama dada.
 *
 * La arista **sin** `branch` es la salida por defecto: la usan los nodos de acción (que no
 * ramifican) y el `logic.switch` cuando ningún caso coincide. Que una condición sin arista
 * `false` termine el run es intencionado — es lo que dibuja el operador cuando quiere
 * «solo si».
 */
export function siguienteNodoId(
  aristas: AristaMin[],
  desdeId: string,
  rama: string | null = null,
): string | null {
  const salidas = aristas.filter((e) => e.fromNodeId === desdeId);
  if (rama !== null) {
    const exacta = salidas.find((e) => e.branch === rama);
    if (exacta) return exacta.toNodeId;
  }
  return salidas.find((e) => e.branch === null)?.toNodeId ?? null;
}

/**
 * Lo que un grafo tiene que cumplir para poder activarse. Devuelve los problemas en
 * castellano, para enseñarlos tal cual en el editor.
 *
 * Se comprueba al ACTIVAR y no al guardar: a medio dibujar el grafo está roto por
 * definición, y un editor que no deja guardar borradores no lo usa nadie.
 */
export function problemasDelGrafo(nodos: NodoMin[], aristas: AristaMin[]): string[] {
  const problemas: string[] = [];
  if (!nodos.length) {
    return ['La automatización no tiene ni un nodo.'];
  }

  const raices = nodos.filter((n) => n.isRoot);
  if (raices.length === 0) problemas.push('Falta el nodo por el que empieza.');
  if (raices.length > 1) problemas.push('Hay más de un nodo de inicio.');

  const ids = new Set(nodos.map((n) => n.id));
  for (const e of aristas) {
    if (!ids.has(e.fromNodeId) || !ids.has(e.toNodeId)) {
      problemas.push('Hay una conexión que apunta a un nodo que no está en este grafo.');
      break;
    }
  }

  // Ciclos. No es una preferencia de estilo: la unique `(runId, nodeId)` de
  // `AutomationRunStep` —la que hace idempotente cada paso— impide volver a pasar por un
  // nodo, así que un bucle se convertiría en un run fallido a mitad de camino. Mejor
  // decirlo al activar que descubrirlo con un cliente delante.
  if (raices.length === 1 && tieneCiclo(raices[0].id, aristas)) {
    problemas.push('El grafo tiene un bucle, y esta versión del motor no los ejecuta.');
  }

  // Nodos sueltos: se avisan porque casi siempre son un enlace que el operador olvidó.
  const alcanzables = raices.length === 1 ? alcanzablesDesde(raices[0].id, aristas) : new Set<string>();
  if (raices.length === 1) {
    const sueltos = nodos.filter((n) => !n.isRoot && !alcanzables.has(n.id));
    if (sueltos.length) problemas.push(`Hay ${sueltos.length} nodo(s) que no se alcanzan desde el inicio.`);
  }

  return problemas;
}

function alcanzablesDesde(raizId: string, aristas: AristaMin[]): Set<string> {
  const vistos = new Set<string>();
  const pila = [raizId];
  while (pila.length) {
    const actual = pila.pop()!;
    for (const e of aristas.filter((x) => x.fromNodeId === actual)) {
      if (vistos.has(e.toNodeId)) continue;
      vistos.add(e.toNodeId);
      pila.push(e.toNodeId);
    }
  }
  return vistos;
}

function tieneCiclo(raizId: string, aristas: AristaMin[]): boolean {
  const enCamino = new Set<string>();
  const cerrados = new Set<string>();
  const visitar = (id: string): boolean => {
    if (enCamino.has(id)) return true;
    if (cerrados.has(id)) return false;
    enCamino.add(id);
    for (const e of aristas.filter((x) => x.fromNodeId === id)) {
      if (visitar(e.toNodeId)) return true;
    }
    enCamino.delete(id);
    cerrados.add(id);
    return false;
  };
  return visitar(raizId);
}
