// Los comparadores del orquestador (v3 feature 18): lo que decide por qué rama sigue el
// grafo. Puro (ver comparadores.check.ts).
//
// Seis operadores y ni uno más: son los que la spec pide y los que un operador entiende
// sin manual. Un motor de expresiones aquí sería un lenguaje que nadie puede depurar
// cuando la automatización le mande el mensaje equivocado a un cliente.
import { Contexto, valorDelCampo } from './contexto';

export const OPERADORES = ['eq', 'neq', 'contains', 'gt', 'lt', 'matches'] as const;
export type Operador = (typeof OPERADORES)[number];

export function esOperador(v: unknown): v is Operador {
  return typeof v === 'string' && (OPERADORES as readonly string[]).includes(v);
}

// Comparar texto sin que un acento o una mayúscula decidan el destino de una venta.
function normal(v: unknown): string {
  return String(v ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim();
}

function numero(v: unknown): number {
  // `''` y `null` NO son 0 aquí: `Number('')` da 0 y haría que un campo vacío pasara un
  // `gt 0` como si valiera algo.
  if (v === null || v === undefined || v === '') return NaN;
  return typeof v === 'number' ? v : Number(v);
}

/**
 * Compara. Devuelve siempre un booleano: un valor ausente da `false`, nunca lanza — un
 * comparador que revienta deja el run muerto a mitad del grafo.
 */
export function comparar(op: Operador, izq: unknown, der: unknown): boolean {
  switch (op) {
    case 'eq':
      return normal(izq) === normal(der);
    case 'neq':
      return normal(izq) !== normal(der);
    case 'contains':
      return normal(izq).includes(normal(der));
    case 'gt': {
      const a = numero(izq);
      const b = numero(der);
      return Number.isFinite(a) && Number.isFinite(b) && a > b;
    }
    case 'lt': {
      const a = numero(izq);
      const b = numero(der);
      return Number.isFinite(a) && Number.isFinite(b) && a < b;
    }
    case 'matches':
      try {
        // `i` fija: la sensibilidad a mayúsculas es justo lo que nadie recuerda activar.
        return new RegExp(String(der ?? ''), 'i').test(String(izq ?? ''));
      } catch {
        // Una regex inválida la escribió una persona en el editor: no coincide, y el paso
        // queda registrado como lo que es.
        return false;
      }
  }
}

// El «Campo» de un nodo de lógica es una ruta CRUDA (sin llaves) que admite la misma tubería
// que `{{...}}`: `vars.lista | cuenta` comparado contra 3 es «si la lista tiene más de tres».
// `valorDelCampo` se mudó a `contexto.ts` cuando el `campos` de la 47 y el `argumentos` de
// `flow.call` pasaron a necesitar la misma resolución: ver allí por qué no son tres copias.

/** `logic.condition`: devuelve la rama `'true'` o `'false'` que el motor busca en las aristas. */
export function ramaDeCondicion(
  config: { campo?: unknown; operador?: unknown; valor?: unknown },
  ctx: Contexto,
): 'true' | 'false' {
  const campo = typeof config.campo === 'string' ? config.campo : '';
  const op = esOperador(config.operador) ? config.operador : 'eq';
  return comparar(op, valorDelCampo(ctx, campo), config.valor) ? 'true' : 'false';
}

/**
 * `logic.switch`: devuelve el nombre del caso que coincide, o `null` para que el motor
 * tome la arista por defecto (la que no lleva `branch`).
 */
export function ramaDeSwitch(
  config: { campo?: unknown; casos?: unknown },
  ctx: Contexto,
): string | null {
  const campo = typeof config.campo === 'string' ? config.campo : '';
  const actual = valorDelCampo(ctx, campo);
  const casos = Array.isArray(config.casos) ? config.casos : [];
  for (const c of casos) {
    const nombre = typeof (c as any)?.rama === 'string' ? (c as any).rama : null;
    if (!nombre) continue;
    const op = esOperador((c as any)?.operador) ? (c as any).operador : 'eq';
    if (comparar(op, actual, (c as any)?.valor)) return nombre;
  }
  return null;
}
