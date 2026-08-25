// 47 — La forma de una respuesta de API, aplanada a rutas que se pueden teclear.
//
// Puro (ver sondeo.check.ts). La llamada de verdad la hace el servicio; aquí solo se convierte
// lo que contestó en la lista que alimenta el autocompletado del editor.
//
// **Habla el vocabulario de `aplanar` del frontend (`rutas.ts:238-247`), no uno propio.** Las
// dos reglas de allí se repiten aquí porque son las mismas rutas: si el sondeo ofreciera
// `data.0.saldo` y el último run ofreciera `data`, el mismo campo tendría dos vocabularios
// según de dónde salieron, y nadie va a entender por qué. El argumento entero, en
// `contrato/47 §3`.
import { claveSegura } from './expresiones';

/**
 * Cuándo un TRAMO de ruta es alcanzable. **No es `NOMBRE_VAR`**, que es la regla de los
 * NOMBRES de variable (tiene que empezar por letra): un `0` de índice no vale como nombre y
 * sí como tramo, y usar la regla equivocada marcaría como inalcanzable media respuesta con
 * listas dentro. La de verdad es la de `RUTA` en `expresiones.ts` —`[A-Za-z0-9_.]`, o sea
 * `[A-Za-z0-9_]+` por tramo— más `claveSegura`, que es lo que `valorDe` aplica al recorrer.
 */
const SEGMENTO = /^[A-Za-z0-9_]+$/;

export function tramoAlcanzable(clave: string): boolean {
  return SEGMENTO.test(clave) && claveSegura(clave);
}

export interface RutaSondeada {
  /** COMPLETA y lista para teclear: `vars.api.json.saldo`. El prefijo lo pone quien llama, no
   *  el cliente: una regla de prefijo escrita dos veces se separa al primer retoque. */
  ruta: string;
  tipo: 'texto' | 'numero' | 'booleano' | 'lista' | 'objeto' | 'nulo';
  ejemplo: unknown;
  /** Esta hoja es un array. NO se expande por índice: para sacar un elemento hace falta
   *  `code.run`, que es la misma frontera que dejó el `map` fuera de esta feature. */
  deLista?: true;
  /** La gramática de `VAR` no acepta esta clave (`account-balance`, `Content-Type`). Viaja
   *  marcada en vez de descartarse: el operador ve ese campo en la respuesta de su API, y si no
   *  lo ve en la lista concluye que el sondeo está roto. Que no entre en el autocompletado es
   *  cosa de la pantalla. */
  alcanzable?: false;
}

export interface Aplanado {
  rutas: RutaSondeada[];
  /** CUÁL tope se alcanzó, no que se alcanzó alguno: «hay más campos» y «hay más profundidad»
   *  son dos frases distintas en pantalla. Ausente —no `false`— cuando no se topó nada: un
   *  campo presente significa que hay algo que decir. */
  truncado?: 'rutas' | 'profundidad';
}

export const MAX_PROFUNDIDAD = 3;
export const MAX_RUTAS = 200;
/** Un ejemplo es para reconocer el campo de un vistazo, no para leer el dato entero. */
const MAX_EJEMPLO = 200;

function tipoDe(v: unknown): RutaSondeada['tipo'] {
  if (v === null || v === undefined) return 'nulo';
  if (Array.isArray(v)) return 'lista';
  switch (typeof v) {
    case 'string':
      return 'texto';
    case 'number':
      return 'numero';
    case 'boolean':
      return 'booleano';
    default:
      return 'objeto';
  }
}

function ejemploDe(v: unknown): unknown {
  if (typeof v === 'string') return v.length > MAX_EJEMPLO ? `${v.slice(0, MAX_EJEMPLO)}…` : v;
  if (Array.isArray(v)) return `${v.length} elemento${v.length === 1 ? '' : 's'}`;
  if (v !== null && typeof v === 'object') return `${Object.keys(v).length} campos`;
  return v ?? null;
}

/**
 * Un objeto a rutas con punto, solo las hojas.
 *
 * `prefijo` es lo que va delante de todo (`vars.api.json`), y sale de `guardarComo`: por eso
 * sondear sin nombre es un 400 y no una ruta relativa.
 */
export function aplanarRespuesta(valor: unknown, prefijo: string): Aplanado {
  const rutas: RutaSondeada[] = [];
  const vistos = new Set<object>();
  let truncado: Aplanado['truncado'];

  const rec = (v: unknown, ruta: string, prof: number) => {
    if (rutas.length >= MAX_RUTAS) {
      truncado = 'rutas';
      return;
    }
    const esObjeto = v !== null && typeof v === 'object' && !Array.isArray(v);
    const cortadoPorHondo = esObjeto && prof >= MAX_PROFUNDIDAD;
    // Un ciclo no debería llegar aquí —viene de `JSON.parse`— pero el `Set` cuesta una línea y
    // el día que esto reciba un objeto de otro sitio, la alternativa es una recursión infinita.
    if (!esObjeto || cortadoPorHondo || vistos.has(v as object)) {
      if (cortadoPorHondo) truncado ??= 'profundidad';
      if (ruta !== prefijo) {
        const clave = ruta.slice(ruta.lastIndexOf('.') + 1);
        rutas.push({
          ruta,
          tipo: tipoDe(v),
          ejemplo: ejemploDe(v),
          ...(Array.isArray(v) ? { deLista: true as const } : {}),
          // Se juzga la ÚLTIMA clave y no la ruta entera: en un tramo inalcanzable no se
          // baja (abajo), así que una ruta con un tramo intermedio inválido no se genera.
          ...(tramoAlcanzable(clave) ? {} : { alcanzable: false as const }),
        });
      }
      return;
    }
    vistos.add(v as object);
    const claves = Object.keys(v as Record<string, unknown>);
    // Un objeto vacío es una hoja: `{}` no tiene nada dentro que ofrecer, pero el campo existe.
    if (!claves.length && ruta !== prefijo) {
      rutas.push({ ruta, tipo: 'objeto', ejemplo: ejemploDe(v) });
      return;
    }
    for (const k of claves) {
      // En una clave inalcanzable NO se baja: `{{vars.x.account-balance.saldo}}` no resuelve
      // por el tramo de en medio, así que ofrecer lo de dentro sería ofrecer varias mentiras
      // en vez de una. Se enseña la clave, marcada, y ahí se para.
      if (!tramoAlcanzable(k)) {
        if (rutas.length >= MAX_RUTAS) {
          truncado = 'rutas';
          return;
        }
        const dentro = (v as Record<string, unknown>)[k];
        rutas.push({
          ruta: `${ruta}.${k}`,
          tipo: tipoDe(dentro),
          ejemplo: ejemploDe(dentro),
          ...(Array.isArray(dentro) ? { deLista: true as const } : {}),
          alcanzable: false as const,
        });
        continue;
      }
      rec((v as Record<string, unknown>)[k], `${ruta}.${k}`, prof + 1);
    }
  };

  rec(valor, prefijo, 0);
  return { rutas, ...(truncado ? { truncado } : {}) };
}
