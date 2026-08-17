// Check de la lista de orígenes de CORS (v6 feature 32). Correr: npx ts-node src/config/cors.check.ts
import * as assert from 'node:assert';
import { corsOriginCheck, corsOrigins } from './cors';

const allow = (origin?: string): boolean => {
  let out: boolean | undefined;
  corsOriginCheck(origin, (_e, ok) => (out = ok));
  return out === true;
};

delete process.env.CORS_ORIGINS;
delete process.env.APP_URL;
assert.deepStrictEqual(corsOrigins(), ['http://localhost:4200'], 'default de desarrollo');

process.env.APP_URL = 'https://app.ejemplo.com';
assert.deepStrictEqual(corsOrigins(), ['https://app.ejemplo.com'], 'cae a APP_URL');

// Coma-separada, con espacios y una entrada vacía por un error de tipeo al final.
process.env.CORS_ORIGINS = 'https://app.ejemplo.com, https://admin.ejemplo.com,';
assert.deepStrictEqual(
  corsOrigins(),
  ['https://app.ejemplo.com', 'https://admin.ejemplo.com'],
  'parte, recorta y descarta vacíos',
);

assert.ok(allow('https://app.ejemplo.com'), 'origen de la lista pasa');
assert.ok(!allow('https://evil.com'), 'origen ajeno no pasa');
// Un vacío colado en la lista no puede convertirse en "permitir todo".
assert.ok(!allow(''), 'origen vacío no es un comodín');
assert.ok(allow(undefined), 'sin Origin (curl / servidor a servidor) pasa');

console.log('cors.check OK');
