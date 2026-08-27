// Check de la frontera con la app Angular: las rutas que este repo le manda al usuario
// tienen que existir allá. Correr: npx ts-node src/frontend-routes.check.ts
//
// Los dos acoplamientos que nombra CLAUDE.md: `ALLOWED_ROUTES` (el asistente sugiere
// navegación) y el enlace de invitación (`APP_URL` + ruta). Si en el frontend se renombra
// una ruta, sin esto el usuario aterriza en el `**` y nada lo detecta.
import * as assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOWED_ROUTES } from './assistant/synthesis';

const CONFIG = join(__dirname, '..', '..', 'whatsops-frontend', 'src', 'app', 'app.config.ts');

if (!existsSync(CONFIG)) {
  // El repo hermano no siempre está clonado. Este check afirma sobre la otra capa: sin
  // ella no hay nada que afirmar, y fallar sería ruido, no una señal.
  console.log('frontend-routes.check SKIP (falta ../whatsops-frontend)');
  process.exit(0);
}

// ponytail: aplana todos los `path:` a un nivel. Vale porque el único padre con hijos
// tiene `path: ''`; si alguna vez se anida bajo un padre con nombre (`crm/clientes`),
// esto dejaría pasar `/clientes` y habría que concatenar el padre.
const declaradas = new Set(
  [...readFileSync(CONFIG, 'utf8').matchAll(/path:\s*'([^']*)'/g)].map(([, p]) => '/' + p),
);
assert.ok(declaradas.size > 5, 'se leyeron las rutas del frontend (¿cambió app.config.ts?)');

for (const r of ALLOWED_ROUTES) {
  assert.ok(declaradas.has(r), `el asistente sugiere ${r} y el frontend no la declara`);
}

// La ruta del enlace de invitación se lee del código, no se teclea aquí: si allá se
// renombra, este check tiene que caerse, no seguir afirmando sobre una ruta que ya no arma.
const src = readFileSync(join(__dirname, 'invitations', 'invitations.service.ts'), 'utf8');
const invitacion = src.match(/\$\{base\}(\/[a-z0-9\-/]*)/)?.[1];
assert.ok(invitacion, 'no se encontró la ruta del enlace de invitación en invitations.service.ts');
assert.ok(declaradas.has(invitacion), `el enlace de invitación apunta a ${invitacion}, no declarada`);

console.log(`frontend-routes.check OK (${ALLOWED_ROUTES.length} del asistente + ${invitacion})`);
