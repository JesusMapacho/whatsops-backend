// Check mínimo de validateCredentials. Correr: npx ts-node src/auth/validate.check.ts
import * as assert from 'node:assert';
import { validateCredentials } from './validate';

// Válido: normaliza email a minúsculas, conserva password.
assert.deepStrictEqual(validateCredentials('A@B.com', '12345678'), {
  email: 'a@b.com',
  password: '12345678',
});

// Email inválido.
assert.throws(() => validateCredentials('no-arroba', '12345678'), /Email/);
// Password corta.
assert.throws(() => validateCredentials('a@b.com', 'corta'), /contraseña/);
// Tipos no-string.
assert.throws(() => validateCredentials(123, '12345678'), /Email/);

console.log('validate.check OK');
