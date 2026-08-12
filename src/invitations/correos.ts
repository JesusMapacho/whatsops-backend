// Lo que se decide sobre una invitación sin tocar la base de datos: cómo se lee la
// lista de correos que el admin pega de golpe, y si el enlace sigue sirviendo.
//
// Puro y sin Nest para poder comprobarlo con node (`invitations.check.ts`).

/** Días que vive un enlace de invitación. */
export const TTL_DIAS = 7;

/** Tope de correos por envío: el modal es para sumar un equipo, no para un buzón. */
export const MAX_POR_ENVIO = 25;

// El mismo criterio que auth/validate.ts. No se persigue el RFC: se persigue que
// nadie se quede fuera por una errata evidente.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function esCorreo(s: unknown): boolean {
  return typeof s === 'string' && EMAIL_RE.test(s);
}

/**
 * Lee lo que venga del modal: una cadena pegada («a@b.com, c@d.com») o ya un array.
 * Recorta, pasa a minúsculas y quita repetidos conservando el orden — si alguien
 * pega la misma dirección dos veces no queremos mandarle dos enlaces distintos.
 *
 * No valida: quién sea inválido se rechaza arriba con su nombre, para poder decir
 * *cuál* está mal en vez de un «lista inválida» sin pistas.
 */
export function correosDe(entrada: unknown): string[] {
  const crudos = Array.isArray(entrada)
    ? entrada.map((e) => String(e ?? ''))
    : String(entrada ?? '').split(/[,\n;]+/);
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const c of crudos) {
    const limpio = c.trim().toLowerCase();
    if (!limpio || vistos.has(limpio)) continue;
    vistos.add(limpio);
    out.push(limpio);
  }
  return out;
}

export function caducaEn(desde: Date, dias = TTL_DIAS): Date {
  return new Date(desde.getTime() + dias * 24 * 60 * 60 * 1000);
}

/**
 * Si el enlace todavía abre la puerta. Las tres razones para que no lo haga son
 * distintas y la pantalla de aceptar las dice por separado, pero el permiso de
 * entrar es uno solo y se decide aquí.
 */
export function vigente(
  inv: { expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null },
  ahora: Date,
): boolean {
  return !inv.acceptedAt && !inv.revokedAt && inv.expiresAt.getTime() > ahora.getTime();
}
