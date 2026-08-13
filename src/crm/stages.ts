// Lógica pura de las etapas del embudo: ordenar, reordenar y decidir si una se puede
// borrar. Sin Prisma en la firma para que el check no necesite base.

export interface EtapaBase {
  id: string;
  name: string;
  position: number;
}

// Las cuatro etapas con las que arranca un tenant. Un tablero vacío con un cartel «crea
// tu primera etapa» es la forma más rápida de que nadie vuelva a entrar; y estas son las
// que el negocio va a RENOMBRAR, no inventar.
export const ETAPAS_INICIALES = [
  'Nuevo prospecto',
  'Contactado',
  'Cotización enviada',
  'En negociación',
] as const;

export const PIPELINE_INICIAL = 'Ventas';

export class StagesError extends Error {}

// Orden del tablero: por `position` y, a igualdad, por nombre. El desempate no es adorno:
// `position` no tiene unique (ver el esquema), así que dos etapas pueden empatar tras una
// escritura concurrente y sin desempate estable el tablero se reordenaría al azar entre
// recargas.
export function ordenar<T extends EtapaBase>(etapas: T[]): T[] {
  return [...etapas].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'es'));
}

/**
 * Traduce un orden pedido por la UI —la lista de ids de izquierda a derecha— a las
 * posiciones que hay que escribir: 0..n-1, sin huecos.
 *
 * Se reescriben TODAS y no solo las que cambiaron: es una query en una transacción y no
 * tiene estados intermedios que proteger. Calcular el mínimo de escrituras costaría más
 * código que las escrituras que ahorra.
 *
 * `existentes` son los ids que la pipeline tiene de verdad. Se exige que la lista sea una
 * permutación exacta: si falta una, quedaría con su posición vieja y aparecería en un
 * sitio que nadie pidió; si sobra un id ajeno, se estaría moviendo la etapa de otra
 * pipeline (o de otro tenant) desde el cuerpo de la petición.
 */
export function reordenar(ids: string[], existentes: string[]): Array<{ id: string; position: number }> {
  if (new Set(ids).size !== ids.length) {
    throw new StagesError('La lista de etapas trae ids repetidos');
  }
  if (ids.length !== existentes.length || !ids.every((id) => existentes.includes(id))) {
    throw new StagesError('La lista de etapas debe traer todas las de la pipeline, y solo esas');
  }
  return ids.map((id, position) => ({ id, position }));
}

/**
 * ¿Se puede borrar esta etapa? Dos frenos, y ninguno sustituye al otro:
 *
 * - **La última no se borra.** Una pipeline sin etapas no es un embudo vacío, es un
 *   tablero al que no se le puede añadir un trato.
 * - **Con tratos abiertos hace falta destino.** No hay borrado en cascada ni tratos
 *   apuntando a una etapa que no existe (la FK es NO ACTION justo para eso). Quien borra
 *   dice a dónde van.
 *
 * El destino tiene que ser otra etapa de la MISMA pipeline: mover tratos a la etapa de
 * otro embudo dejaría `Deal.pipelineId` y `Deal.stageId` contando cosas distintas.
 */
export function puedeBorrar(opciones: {
  stageId: string;
  etapasDeLaPipeline: string[];
  tratosAbiertos: number;
  moveToStageId?: string;
}): { moveToStageId?: string } {
  const { stageId, etapasDeLaPipeline, tratosAbiertos, moveToStageId } = opciones;
  if (!etapasDeLaPipeline.includes(stageId)) {
    throw new StagesError('La etapa no pertenece a esta pipeline');
  }
  if (etapasDeLaPipeline.length <= 1) {
    throw new StagesError('Una pipeline necesita al menos una etapa');
  }
  if (tratosAbiertos === 0) return {};

  if (!moveToStageId) {
    throw new StagesError(
      `La etapa tiene ${tratosAbiertos} trato(s); indica a qué etapa moverlos (moveToStageId)`,
    );
  }
  if (moveToStageId === stageId) {
    throw new StagesError('No se pueden mover los tratos a la etapa que se está borrando');
  }
  if (!etapasDeLaPipeline.includes(moveToStageId)) {
    throw new StagesError('La etapa destino debe ser de la misma pipeline');
  }
  return { moveToStageId };
}

// La primera etapa de la pipeline: donde caen los tratos nuevos que no dicen etapa, y
// donde los pone la regla de alta automática (feature 38).
export function primeraEtapa<T extends EtapaBase>(etapas: T[]): T {
  const ordenadas = ordenar(etapas);
  if (!ordenadas.length) throw new StagesError('La pipeline no tiene etapas');
  return ordenadas[0];
}
