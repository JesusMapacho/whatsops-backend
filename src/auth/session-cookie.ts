// La sesión vive en una cookie HttpOnly (v6 feature 31): lo que el JavaScript de la
// página no puede leer, no se lo puede llevar un script inyectado ni una dependencia
// de npm comprometida. El token sigue siendo al portador — eso no lo arregla ningún
// esquema —, pero deja de estar a mano de cualquier `document.*`.
//
// ponytail: sin `cookie-parser`. Leer una cookie es partir una cabecera por `;`, y el
// check que la spec pide (ausente / con basura / varias en la misma cabecera) hay que
// escribirlo igual. Entra la dependencia si algún día hacen falta cookies firmadas.
import { randomUUID } from 'node:crypto';

export const SESSION_COOKIE = 'wo_session';
// Legible a propósito (sin HttpOnly): el interceptor del frontend la copia en el header
// y el guard compara los dos. Es el patrón de doble envío; si un script puede leer esta,
// puede leer la suya, pero no la de otro origen, que es lo que frena el CSRF.
export const CSRF_COOKIE = 'wo_csrf';
export const CSRF_HEADER = 'x-csrf-token';

// El mismo día que dura el JWT (`auth.module.ts`). Si se separan, la sesión muere en el
// navegador antes o después que en el servidor y el síntoma es un 401 sin explicación.
const MAX_AGE = 86400;

/**
 * `Secure` explícito y **encendido por defecto**: el navegador descarta una cookie
 * `Secure` que llegue por http, así que en desarrollo sobre `http://localhost` hay que
 * apagarlo con `COOKIE_SECURE=false`. Al revés — default inseguro — un despliegue que
 * olvide la variable manda la sesión en claro y nadie se entera.
 */
function flags(maxAge: number): string {
  const secure = process.env.COOKIE_SECURE !== 'false' ? '; Secure' : '';
  // COOKIE_DOMAIN es obligatorio en cuanto el front y la API son subdominios distintos:
  // sin `Domain`, la cookie es host-only (solo api.dominio) y `app.dominio` no puede leer
  // `wo_csrf` → todas las escrituras darían 403. En desarrollo no hace falta porque las
  // cookies ignoran el puerto: 4200 y 3000 comparten el dominio `localhost`.
  const dominio = process.env.COOKIE_DOMAIN ? `; Domain=${process.env.COOKIE_DOMAIN}` : '';
  // SameSite=Lax: front y API viven en el mismo sitio (app.dominio / api.dominio), así
  // que el navegador ya frena el CSRF de terceros y el doble envío es la segunda vuelta
  // de llave. Servirlos en dominios distintos obligaría a None y a otra spec.
  return `Path=/${dominio}; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}

export function sessionCookies(jwt: string, csrf: string = randomUUID()): string[] {
  return [
    `${SESSION_COOKIE}=${jwt}; HttpOnly; ${flags(MAX_AGE)}`,
    `${CSRF_COOKIE}=${csrf}; ${flags(MAX_AGE)}`,
  ];
}

export function clearedCookies(): string[] {
  return [
    `${SESSION_COOKIE}=; HttpOnly; ${flags(0)}`,
    `${CSRF_COOKIE}=; ${flags(0)}`,
  ];
}

export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    // eq > 0: un `=` al principio no es un nombre de cookie, es basura.
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// Tipado estructural en vez de `express.Response`: el backend no trae `@types/express`
// y esto es lo único que se le pide al objeto.
export type CookieSink = { setHeader(name: string, value: string[]): void };

export function setSession(res: CookieSink, jwt: string): void {
  res.setHeader('Set-Cookie', sessionCookies(jwt));
}

export function clearSession(res: CookieSink): void {
  res.setHeader('Set-Cookie', clearedCookies());
}

/**
 * Emite la cookie y devuelve el cuerpo **sin** el token: si el JWT viaja en el JSON, el
 * frontend tiene que guardarlo en algún sitio y volvemos a `localStorage`. Lo usan las
 * tres puertas que abren sesión: login, registro y aceptar una invitación.
 *
 * **Y es donde se hace valer el segundo factor.** Esta función es el único punto de todo el
 * backend que escribe `Set-Cookie`, así que el freno vive aquí y no en `login()`: puesto en
 * `login()` habría que acordarse tres veces, y la de aceptar una invitación es justo la que
 * se olvida. `mfaPendiente` es un campo **obligatorio** del parámetro a propósito — el
 * compilador obliga a resolverlo en cada puerta nueva, en vez de dejar que un default lo
 * tape. Lo calcula `AuthService.sign()`, que es por donde pasan las tres.
 *
 * Si salta, es un **bug** y no un estado del usuario: `login` ya devuelve el desafío antes
 * de llegar aquí. De ahí un `Error` pelado y un 500 ruidoso, que es como tiene que fallar
 * «casi emitimos una sesión saltándonos el segundo factor».
 */
export function openSession<T>(
  res: CookieSink,
  sesion: { accessToken: string; user: T; mfaPendiente: boolean },
): { user: T } {
  if (sesion.mfaPendiente) {
    throw new Error('No se puede abrir sesión: falta el segundo factor.');
  }
  setSession(res, sesion.accessToken);
  return { user: sesion.user };
}
