// Mutaciones sobre un mensaje YA persistido: reacciones, borrado y edición.
// Puro, sin DB → testeable en aislamiento (mutations.check.ts).

// Reacciones acumuladas de un mensaje: emoji → quiénes lo pusieron.
// Se guarda en `Message.payload.reactions`, no en una tabla: no se consulta ni se
// ordena por ello, y payload ya es la fuente del render y ya viaja por el socket.
export type Reactions = Record<string, string[]>;

// Aplica una reacción. WhatsApp permite UNA reacción por persona y mensaje, así
// que poner otra reemplaza la anterior; `emoji` vacío la quita.
//
// ponytail: read-modify-write sobre el JSON, así que con dos réplicas gana el
// último que escribe. Para emojis es aceptable. Upgrade: jsonb_set vía $executeRaw.
export function applyReaction(
  existing: unknown,
  author: string,
  emoji: string,
): Reactions {
  const base: Reactions = isReactions(existing) ? clone(existing) : {};
  if (!author) return base;

  // Un autor solo tiene una reacción viva: se retira de donde estuviera.
  for (const key of Object.keys(base)) {
    base[key] = base[key].filter((a) => a !== author);
    if (!base[key].length) delete base[key];
  }
  if (!emoji) return base; // texto vacío = quitar la reacción

  base[emoji] = [...(base[emoji] ?? []), author];
  return base;
}

function isReactions(v: unknown): v is Reactions {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (x) => Array.isArray(x) && x.every((i) => typeof i === 'string'),
  );
}

function clone(r: Reactions): Reactions {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [...v]]));
}
