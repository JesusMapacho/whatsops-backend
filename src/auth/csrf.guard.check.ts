// Check del guard de CSRF (v6 feature 31). Correr: npx ts-node src/auth/csrf.guard.check.ts
import * as assert from 'node:assert';
import { csrfAllowed } from './csrf.guard';
import { CSRF_COOKIE, CSRF_HEADER } from './session-cookie';

const conCookie = (v: string, extra: Record<string, unknown> = {}) => ({
  cookie: `wo_session=jwt; ${CSRF_COOKIE}=${v}`,
  ...extra,
});

// Header que casa con la cookie → pasa.
assert.ok(
  csrfAllowed(false, 'POST', conCookie('tok-1', { [CSRF_HEADER]: 'tok-1' })),
  'header que casa → pasa',
);
// Falta el header → no pasa.
assert.ok(!csrfAllowed(false, 'POST', conCookie('tok-1')), 'sin header → 403');
// Header que no casa → no pasa.
assert.ok(
  !csrfAllowed(false, 'POST', conCookie('tok-1', { [CSRF_HEADER]: 'otro' })),
  'header distinto → 403',
);
// Sin cookie no vale mandar cualquier header: si valiera, el atacante elige los dos.
assert.ok(
  !csrfAllowed(false, 'POST', { [CSRF_HEADER]: 'inventado' }),
  'header sin cookie → 403',
);
// Cookie vacía tampoco: dos vacíos son iguales y colarían.
assert.ok(!csrfAllowed(false, 'POST', conCookie('', { [CSRF_HEADER]: '' })), 'vacío = vacío no pasa');

// Los métodos que no mutan no lo exigen.
for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) {
  assert.ok(csrfAllowed(false, m, { cookie: 'wo_session=jwt' }), `${m} no lo exige`);
}
// Los que mutan, todos.
for (const m of ['POST', 'patch', 'PUT', 'DELETE']) {
  assert.ok(!csrfAllowed(false, m, { cookie: 'wo_session=jwt' }), `${m} sí lo exige`);
}

// Ruta @Public(): exenta aunque mute (webhooks con firma HMAC, login, registro).
assert.ok(csrfAllowed(true, 'POST', {}), 'ruta pública exenta');

console.log('csrf.guard.check OK');
