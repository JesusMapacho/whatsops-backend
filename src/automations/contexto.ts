// El contexto de un run: lo que sabe la automatización mientras avanza por el grafo.
// Puro (ver contexto.check.ts) — lo evalúan los comparadores y lo interpolan los textos.
//
// Empieza con lo que la disparó (el mensaje, el contacto, la conversación) y cada nodo le
// agrega su salida bajo `nodos.<id>`. Es un Json en `AutomationRun.context`, así que todo
// lo que entre aquí tiene que ser serializable.
//
// Cuatro espacios de nombres, y la diferencia importa:
//   `mensaje` / `contacto` / `conversacion` — lo que disparó el run.
//   `nodos.<id>`   — la salida cruda de cada nodo. Es el cuid de la fila, que CAMBIA en cada
//                    guardado del grafo (`guardarGrafo` recrea los nodos), así que no sirve
//                    para escribirlo a mano en una config: para eso está `vars`.
//   `vars.<nombre>` — lo que el operador decidió nombrar («Guardar el resultado como»). Vive
//                    y muere con el run.
//   `ajustes.<nombre>` — las constantes del negocio (`TenantVariable`). No se persisten en el
//                    run: se leen frescas en cada paso, para que cambiar un precio en la
//                    pantalla alcance también a los runs que ya están en vuelo.
//   `disparador`   — la carga de lo que hizo ARRANCAR el run: el texto y la palabra que
//                    coincidió, el patrón del cron, o el cuerpo de la llamada externa. Se
//                    escribe al crear el run y no cambia: la respuesta a un `wait.reply` NO
//                    es un disparo nuevo (esa llega, como siempre, por `mensaje.texto`).

export type Contexto = Record<string, unknown>;

/**
 * Lee una ruta con puntos: `mensaje.texto`, `contacto.nombre`, `vars.total`, `ajustes.precio_kg`.
 * Devuelve `undefined` si el camino se corta — nunca lanza, porque un comparador que
 * revienta con un campo ausente pararía la automatización a mitad del grafo.
 */
export function valorDe(ctx: Contexto, ruta: string): unknown {
  let actual: unknown = ctx;
  for (const parte of ruta.split('.')) {
    if (actual === null || typeof actual !== 'object') return undefined;
    // La cadena de prototipos no es contexto. `{{x.constructor}}` devolvía una función, y
    // como `interpolar` solo trata aparte los `object`, acababa imprimiendo su código
    // fuente en un mensaje a un cliente. Con el cuerpo de un webhook —anidado y de fuera—
    // eso pasa de rareza a alcanzable.
    if (parte === '__proto__' || parte === 'constructor' || parte === 'prototype') return undefined;
    actual = (actual as Record<string, unknown>)[parte];
  }
  return actual;
}

// Mismo `{{ }}` que las plantillas de Meta (`messaging/template-params.ts`) y que los
// masivos del v5: el operador ya conoce esa sintaxis, no se le enseña una segunda.
const VAR = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/**
 * Sustituye `{{ruta}}` por su valor. Una variable que no existe se sustituye por **vacío**
 * y no por el literal `{{nombre}}`: el texto sale hacia un cliente real, y «Hola
 * {{nombre}}» es peor que «Hola».
 */
export function interpolar(texto: string, ctx: Contexto): string {
  return texto.replace(VAR, (_, ruta: string) => {
    const v = valorDe(ctx, ruta);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/**
 * La carga del disparador. `tipo` es la key del catálogo; el resto depende de cuál sea.
 * Es lo que se guarda en `vars.<nombre>` cuando el nodo de inicio lleva un
 * «Guardar el resultado como».
 */
export interface Disparador {
  tipo: string;
  [k: string]: unknown;
}

/** Lo que ve un run disparado por un mensaje entrante. */
export function contextoDeMensaje(msg: {
  texto: string;
  wamid?: string | null;
  contacto?: { id: string; nombre?: string | null; waId?: string | null } | null;
  conversationId?: string | null;
  /** Key del catálogo del trigger que coincidió, y la palabra si fue `message.keyword`. */
  tipo?: string;
  palabra?: string | null;
}): Contexto {
  return {
    mensaje: { texto: msg.texto, wamid: msg.wamid ?? null },
    contacto: {
      // `id` lo necesitan los nodos del CRM (`deal.create`, `task.create`): sin él, el
      // catálogo no puede tocar la ficha de quien escribió.
      id: msg.contacto?.id ?? null,
      nombre: msg.contacto?.nombre ?? null,
      waId: msg.contacto?.waId ?? null,
    },
    conversacion: { id: msg.conversationId ?? null },
    disparador: {
      tipo: msg.tipo ?? 'message.inbound',
      texto: msg.texto,
      wamid: msg.wamid ?? null,
      palabra: msg.palabra ?? null,
    },
    nodos: {},
    vars: {},
  };
}

/**
 * Nombre de variable válido. Tiene que ser alcanzable desde `{{vars.<nombre>}}`, y el
 * `VAR` de arriba solo acepta `[A-Za-z0-9_.]`: un nombre con un punto («a.b») partiría la
 * ruta en dos y un nombre con espacio no lo encontraría nunca.
 */
export const NOMBRE_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Guarda una variable con nombre bajo `vars.<nombre>`, sin mutar el contexto anterior. */
export function conVariable(ctx: Contexto, nombre: string, valor: unknown): Contexto {
  const vars = (ctx.vars ?? {}) as Record<string, unknown>;
  return { ...ctx, vars: { ...vars, [nombre]: valor ?? null } };
}

/** Guarda la salida de un nodo bajo `nodos.<nodeId>` sin mutar el contexto anterior. */
export function conSalida(ctx: Contexto, nodeId: string, salida: unknown): Contexto {
  const nodos = (ctx.nodos ?? {}) as Record<string, unknown>;
  return { ...ctx, nodos: { ...nodos, [nodeId]: salida ?? null } };
}
