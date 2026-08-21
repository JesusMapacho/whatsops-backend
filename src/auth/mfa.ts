// Decisiones puras del segundo factor: a quién se le exige, y el freno de intentos.
// Sin DB y sin Nest, para poder comprobarlas en aislamiento (mfa.check.ts), igual que
// `waha.reconcile.ts` separa la decisión del efecto.

/** Lo que hace falta saber de un usuario para decidir. Un subconjunto de `User`. */
export interface UsuarioMfa {
  isPlatform: boolean;
  totpConfirmedAt: Date | null;
  totpFailures: number;
  totpLockedUntil: Date | null;
}

/**
 * ¿Esta cuenta necesita segundo factor?
 *
 * Hoy: las de plataforma y solo esas. Es **el único sitio** donde vive esa política — las
 * columnas de `User` son genéricas, así que extenderlo a los admins de un tenant es
 * cambiar esta función, no migrar la tabla.
 *
 * Se decide por `isPlatform` y no por el tenant de plataforma porque `isPlatform` es lo que
 * de verdad abre `/platform/*` y `/error-logs/*` (los guards lo releen de la DB por
 * request). Si algún día vuelven a divergir, lo que manda es quién puede cruzar tenants.
 */
export function requiereSegundoFactor(u: Pick<UsuarioMfa, 'isPlatform'>): boolean {
  return u.isPlatform === true;
}

/** Qué toca hacer tras validar la contraseña. */
export type EtapaMfa =
  | { etapa: 'sesion' } //  no necesita segundo factor: cookie directa
  | { etapa: 'enroll' } //  lo necesita y no lo tiene: obligado a enrolar
  | { etapa: 'mfa' }; //    lo tiene: pedir el código

export function etapaTrasPassword(u: UsuarioMfa): EtapaMfa {
  if (!requiereSegundoFactor(u)) return { etapa: 'sesion' };
  return u.totpConfirmedAt ? { etapa: 'mfa' } : { etapa: 'enroll' };
}

// --- Freno de intentos ---------------------------------------------------------------
//
// Mismo idioma que `verification.service.ts`: contar, y al pasar el tope devolver 429. La
// diferencia es que aquí no hay filas que contar (un TOTP no se guarda), así que el
// contador vive en dos columnas de `User`.
//
// Hace falta de verdad: seis dígitos son un millón de combinaciones y, con la tolerancia de
// ±1 paso, en cada instante hay 3 códigos válidos. Sin freno eso se agota.

/** Fallos seguidos antes de bloquear. */
export const MAX_FALLOS = 5;

/** Cuánto dura el bloqueo. */
export const BLOQUEO_MS = 15 * 60 * 1000;

export function estaBloqueado(u: Pick<UsuarioMfa, 'totpLockedUntil'>, ahoraMs: number): boolean {
  return !!u.totpLockedUntil && u.totpLockedUntil.getTime() > ahoraMs;
}

/**
 * Cómo quedan las columnas tras un intento.
 *
 * Al acertar se limpia todo: si no, cuatro fallos de hace un mes bloquearían al primer
 * dedazo de hoy.
 */
export function trasIntento(
  u: Pick<UsuarioMfa, 'totpFailures'>,
  acerto: boolean,
  ahoraMs: number,
): { totpFailures: number; totpLockedUntil: Date | null } {
  if (acerto) return { totpFailures: 0, totpLockedUntil: null };
  const fallos = u.totpFailures + 1;
  return {
    totpFailures: fallos,
    totpLockedUntil: fallos >= MAX_FALLOS ? new Date(ahoraMs + BLOQUEO_MS) : null,
  };
}
