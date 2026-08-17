// Check de la cookie de sesión (v6 feature 31). Correr: npx ts-node src/auth/session-cookie.check.ts
import * as assert from 'node:assert';

// Antes de importar: el módulo lee COOKIE_SECURE en cada llamada, pero fijarlo aquí deja
// el caso de desarrollo (http://localhost) como el que se comprueba por defecto.
process.env.COOKIE_SECURE = 'false';

import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  clearedCookies,
  readCookie,
  sessionCookies,
} from './session-cookie';

// ── readCookie ────────────────────────────────────────────────────────────────
assert.strictEqual(readCookie(undefined, SESSION_COOKIE), null, 'sin cabecera → null');
assert.strictEqual(readCookie('', SESSION_COOKIE), null, 'cabecera vacía → null');
assert.strictEqual(readCookie('otra=1', SESSION_COOKIE), null, 'cookie ausente → null');
// Basura: nombres sin valor, `=` al principio, espacios sueltos.
assert.strictEqual(readCookie('=x; ;;  ; sin-igual', SESSION_COOKIE), null, 'basura → null');
// Varias cookies en la misma cabecera, con y sin espacio tras el `;`.
assert.strictEqual(
  readCookie(`tema=oscuro; ${SESSION_COOKIE}=abc.def;${CSRF_COOKIE}=u-1`, SESSION_COOKIE),
  'abc.def',
  'encuentra la de en medio',
);
assert.strictEqual(
  readCookie(`tema=oscuro; ${SESSION_COOKIE}=abc.def;${CSRF_COOKIE}=u-1`, CSRF_COOKIE),
  'u-1',
  'encuentra la última sin espacio delante',
);
// Un prefijo no cuenta como coincidencia: `wo_session_old` no es `wo_session`.
assert.strictEqual(readCookie(`${SESSION_COOKIE}_old=viejo`, SESSION_COOKIE), null, 'prefijo no cuenta');

// ── sessionCookies / clearedCookies ───────────────────────────────────────────
const [sess, csrf] = sessionCookies('jwt.de.prueba', 'csrf-fijo');
assert.ok(sess.startsWith(`${SESSION_COOKIE}=jwt.de.prueba;`), 'la sesión lleva el JWT');
assert.ok(sess.includes('HttpOnly'), 'la sesión es HttpOnly');
assert.ok(sess.includes('SameSite=Lax'), 'SameSite=Lax');
assert.ok(!sess.includes('Secure'), 'COOKIE_SECURE=false quita Secure (dev sobre http)');
assert.ok(!csrf.includes('HttpOnly'), 'la de CSRF es legible a propósito');
assert.ok(csrf.startsWith(`${CSRF_COOKIE}=csrf-fijo;`), 'la de CSRF lleva el valor dado');
// Y el JWT se puede volver a leer de lo que se emitió (ida y vuelta).
assert.strictEqual(readCookie(`${sess.split(';')[0]}`, SESSION_COOKIE), 'jwt.de.prueba');

// Con Secure encendido (el default de producción).
process.env.COOKIE_SECURE = 'true';
assert.ok(sessionCookies('x')[0].includes('; Secure'), 'con COOKIE_SECURE=true sale Secure');
process.env.COOKIE_SECURE = 'false';

// COOKIE_DOMAIN: sin él la cookie es host-only y `app.dominio` no puede leer `wo_csrf`.
assert.ok(!sessionCookies('x')[1].includes('Domain='), 'sin la env no se pone Domain (dev)');
process.env.COOKIE_DOMAIN = '.ejemplo.com';
assert.ok(
  sessionCookies('x').every((c) => c.includes('; Domain=.ejemplo.com;')),
  'con la env, Domain en las dos',
);
assert.ok(clearedCookies().every((c) => c.includes('; Domain=.ejemplo.com;')), 'y al borrarlas');
delete process.env.COOKIE_DOMAIN;

// Cerrar sesión: caducan las dos, y la de sesión sigue siendo HttpOnly (si no, el
// navegador la trata como otra cookie y no reemplaza la que hay).
const borradas = clearedCookies();
assert.strictEqual(borradas.length, 2, 'se borran las dos');
assert.ok(borradas.every((c) => c.includes('Max-Age=0')), 'Max-Age=0 en las dos');
assert.ok(borradas[0].includes('HttpOnly'), 'la de sesión se borra con los mismos flags');

console.log('session-cookie.check OK');
