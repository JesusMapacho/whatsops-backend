// El contexto de un run: lo que sabe la automatización mientras avanza por el grafo.
// Puro (ver contexto.check.ts) — lo evalúan los comparadores y lo interpolan los textos.
//
// Empieza con lo que la disparó (el mensaje, el contacto, la conversación) y cada nodo le
// agrega su salida bajo `nodos.<key>`. Es un Json en `AutomationRun.context`, así que todo
// lo que entre aquí tiene que ser serializable.

export type Contexto = Record<string, unknown>;

/**
 * Lee una ruta con puntos: `mensaje.texto`, `contacto.nombre`, `nodos.deal_create.id`.
 * Devuelve `undefined` si el camino se corta — nunca lanza, porque un comparador que
 * revienta con un campo ausente pararía la automatización a mitad del grafo.
 */
export function valorDe(ctx: Contexto, ruta: string): unknown {
  let actual: unknown = ctx;
  for (const parte of ruta.split('.')) {
    if (actual === null || typeof actual !== 'object') return undefined;
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

/** Lo que ve un run disparado por un mensaje entrante. */
export function contextoDeMensaje(msg: {
  texto: string;
  wamid?: string | null;
  contacto?: { id: string; nombre?: string | null; waId?: string | null } | null;
  conversationId?: string | null;
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
    nodos: {},
  };
}

/** Guarda la salida de un nodo bajo `nodos.<nodeId>` sin mutar el contexto anterior. */
export function conSalida(ctx: Contexto, nodeId: string, salida: unknown): Contexto {
  const nodos = (ctx.nodos ?? {}) as Record<string, unknown>;
  return { ...ctx, nodos: { ...nodos, [nodeId]: salida ?? null } };
}
