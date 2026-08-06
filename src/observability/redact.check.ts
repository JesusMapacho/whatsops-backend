// Check de redacción. Correr: npx ts-node src/observability/redact.check.ts
import * as assert from 'node:assert';
import { redact } from './redact';

const input = {
  email: 'a@b.com',
  password: 'secret123',
  accessToken: 'EAAB-xyz',
  nested: { authorization: 'Bearer abc', note: 'hola' },
  card: '4111111111111111',
  freeText: 'mi tarjeta 4111 1111 1111 1111 gracias',
  list: [{ apiKey: 'k' }, 'plain'],
  // Header real de WAHA: en minúsculas es `x-api-key`, que NO contiene "apikey".
  headers: { 'X-Api-Key': 'waha-instance-key', 'x-webhook-hmac': 'abc' },
};

const out = redact(input) as any;

assert.strictEqual(out.email, 'a@b.com', 'no sensible se conserva');
assert.strictEqual(out.password, '[REDACTED]', 'password redactado');
assert.strictEqual(out.accessToken, '[REDACTED]', 'accessToken redactado');
assert.strictEqual(out.nested.authorization, '[REDACTED]', 'authorization anidado redactado');
assert.strictEqual(out.nested.note, 'hola', 'texto anidado inocuo intacto');
assert.strictEqual(out.card, '[REDACTED]', 'card por clave redactado');
assert.ok(!out.freeText.includes('4111'), 'PAN en texto libre redactado');
assert.strictEqual(out.list[0].apiKey, '[REDACTED]', 'apiKey en array redactado');
assert.strictEqual(out.list[1], 'plain', 'string plano en array intacto');
// La api key de WAHA es de instancia: filtrarla compromete a TODOS los tenants.
assert.strictEqual(out.headers['X-Api-Key'], '[REDACTED]', 'X-Api-Key redactado');
// El HMAC es una firma, no la clave: no hace falta redactarlo.
assert.strictEqual(out.headers['x-webhook-hmac'], 'abc');

// No muta la entrada original.
assert.strictEqual(input.password, 'secret123', 'entrada original intacta');

console.log('redact.check OK');
