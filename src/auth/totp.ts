// TOTP (RFC 6238) sobre HOTP (RFC 4226). Todo lo puro y sin DB del segundo factor vive
// aquí, como `webhook/waha.ts` hace con su firma. Comprobado en totp.check.ts contra los
// vectores publicados en los propios RFC.
//
// ponytail: a mano y sin dependencia. No es inventar criptografía — el HMAC es de la
// stdlib y el truncamiento son seis líneas del RFC—, y el resultado se compara contra
// vectores oficiales, que es lo que lo hace defendible. Encaja con la doctrina del repo:
// las únicas dependencias de auth son `bcrypt` y `@nestjs/jwt`; el resto es `node:crypto`
// (ver `session-cookie.ts`, `validate.ts`, `invitations.service.ts`). Si algún día molesta,
// `otplib` es el reemplazo y este check sigue valiendo como red.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Segundos por paso. 30 es lo que asumen todas las apps autenticadoras. */
export const PASO_S = 30;

/** Dígitos del código. 6 es lo único que aceptan Google Authenticator y compañía. */
export const DIGITOS = 6;

/**
 * Pasos de tolerancia hacia atrás y hacia adelante.
 *
 * 1 = ±30 s. Con 0 el reloj del teléfono desincronizado por unos segundos haría fallar
 * códigos correctos, que es el reporte de soporte clásico. Con 2 o más se ensancha la
 * ventana de reutilización sin ganar nada: el anti-replay de `totpLastCounter` la cierra,
 * pero cuanto más estrecha, menos hay que confiar en él.
 */
export const TOLERANCIA = 1;

const ALFABETO_B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Secreto nuevo: 20 bytes (lo que recomienda el RFC 4226 para HMAC-SHA1), en base32. */
export function generarSecreto(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let valor = 0;
  let salida = '';
  for (const byte of buf) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO_B32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) salida += ALFABETO_B32[(valor << (5 - bits)) & 31];
  return salida; // sin relleno `=`: las apps autenticadoras no lo quieren
}

/**
 * Base32 → bytes. Tolerante a propósito con lo que teclea una persona: ignora espacios,
 * guiones, el relleno `=` y no distingue mayúsculas. Lanza si aparece un carácter que no
 * es del alfabeto, en vez de tratarlo como cero — un secreto mal copiado tiene que fallar
 * al enrolar, no producir códigos que nunca cuadran.
 */
export function base32Decode(texto: string): Buffer {
  const limpio = texto.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0;
  let valor = 0;
  const bytes: number[] = [];
  for (const c of limpio) {
    const i = ALFABETO_B32.indexOf(c);
    if (i < 0) throw new Error('El secreto no es base32 válido.');
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * HOTP (RFC 4226 §5.3): HMAC-SHA1 del contador en 8 bytes big-endian, truncamiento
 * dinámico por el nibble bajo del último byte, y módulo 10^dígitos.
 */
export function codigoHotp(secretoB32: string, contador: number, digitos = DIGITOS): string {
  const clave = base32Decode(secretoB32);
  const buf = Buffer.alloc(8);
  // El contador cabe de sobra en 48 bits (el año 10000 está a 2.6e11 pasos), y
  // `writeUIntBE` topa en 6 bytes. Los dos primeros quedan en cero, que es correcto.
  buf.writeUIntBE(contador, 2, 6);
  const mac = createHmac('sha1', clave).update(buf).digest();
  const desplazamiento = mac[mac.length - 1] & 0x0f;
  const truncado =
    ((mac[desplazamiento] & 0x7f) << 24) |
    (mac[desplazamiento + 1] << 16) |
    (mac[desplazamiento + 2] << 8) |
    mac[desplazamiento + 3];
  return String(truncado % 10 ** digitos).padStart(digitos, '0');
}

/** El contador TOTP de un instante. `ahoraMs` explícito para poder probarlo. */
export function contadorTotp(ahoraMs: number, pasoS = PASO_S): number {
  return Math.floor(ahoraMs / 1000 / pasoS);
}

export function codigoTotp(secretoB32: string, ahoraMs: number, pasoS = PASO_S): string {
  return codigoHotp(secretoB32, contadorTotp(ahoraMs, pasoS));
}

/**
 * Verifica un código y devuelve **el contador que acertó**, o `null`.
 *
 * Devolver el contador y no un booleano es lo que permite el anti-replay: quien llama
 * guarda ese número y rechaza después todo contador `<=`. Sin eso, un código visto por
 * encima del hombro sirve el resto de su ventana más la tolerancia.
 *
 * `minContador` deja rechazar aquí mismo lo ya usado, para que la comparación en tiempo
 * constante sea lo único que decida.
 */
export function verificarTotp(
  secretoB32: string,
  codigo: string,
  ahoraMs: number,
  opciones: { tolerancia?: number; minContador?: number; pasoS?: number } = {},
): number | null {
  const { tolerancia = TOLERANCIA, minContador, pasoS = PASO_S } = opciones;
  if (typeof codigo !== 'string' || !new RegExp(`^\\d{${DIGITOS}}$`).test(codigo)) return null;

  const centro = contadorTotp(ahoraMs, pasoS);
  for (let d = -tolerancia; d <= tolerancia; d++) {
    const contador = centro + d;
    if (contador < 0) continue;
    if (minContador !== undefined && contador <= minContador) continue;
    if (igualEnTiempoConstante(codigoHotp(secretoB32, contador), codigo)) return contador;
  }
  return null;
}

/** Comparación de dos códigos de la misma longitud, sin filtrar por tiempo. */
function igualEnTiempoConstante(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * El `otpauth://` que entiende cualquier app autenticadora.
 *
 * `emisor` va dos veces a propósito (en la etiqueta y en el parámetro): es lo que
 * recomienda la especificación de Key URI de Google y lo que hace que la app agrupe la
 * cuenta bajo el nombre correcto en vez de dejarla suelta.
 */
export function uriOtpauth(secretoB32: string, cuenta: string, emisor = 'WhatsOps'): string {
  const etiqueta = encodeURIComponent(`${emisor}:${cuenta}`);
  const params = new URLSearchParams({
    secret: secretoB32,
    issuer: emisor,
    algorithm: 'SHA1',
    digits: String(DIGITOS),
    period: String(PASO_S),
  });
  return `otpauth://totp/${etiqueta}?${params.toString()}`;
}

/**
 * Códigos de respaldo: 10 caracteres de base32 en dos grupos, legibles al dictado.
 *
 * Sin dígitos ambiguos que confundir al teclearlos desde papel — el alfabeto base32 ya no
 * tiene 0, 1, 8 ni 9. 50 bits de entropía por código; se guardan con `bcrypt` y son de un
 * solo uso, así que no hace falta más.
 */
export function generarCodigoRespaldo(): string {
  const b32 = base32Encode(randomBytes(7)).slice(0, 10);
  return `${b32.slice(0, 5)}-${b32.slice(5)}`;
}

/** Normaliza para comparar: sin guiones ni espacios, en mayúsculas. */
export function normalizarCodigoRespaldo(codigo: string): string {
  return String(codigo ?? '').toUpperCase().replace(/[\s-]/g, '');
}
