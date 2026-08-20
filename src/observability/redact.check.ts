// Check de redacción. Correr: npx ts-node src/observability/redact.check.ts
import * as assert from 'node:assert';
import { esRutaDeHook, redact, redactPath } from './redact';

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

// Listas de destinatarios: PII de gente que todavía NO es cliente. Un 500 al crear
// un envío masivo persistiría el CSV entero en ErrorLog.requestBody, que el
// super-admin lee cross-tenant.
const envio = redact({ csv: '5218715172350,Ana\n5215555555555,Luis', confirmCount: 2 }) as any;
assert.strictEqual(envio.csv, '[REDACTED]');
// El resto del cuerpo sigue siendo legible: sin eso el log no sirve para depurar.
assert.strictEqual(envio.confirmCount, 2);
assert.strictEqual((redact({ recipients: ['5218715172350'] }) as any).recipients, '[REDACTED]');
assert.strictEqual((redact({ phones: ['5218715172350'] }) as any).phones, '[REDACTED]');

// --- el token del hook va en la RUTA ---
// Esto es la prueba escrita de que un 404 sobre /hooks/<token> no deja el token en
// `ErrorLog.path`. Sin sesión, esa fila lleva `tenantId` nulo y la lee el super-admin
// cross-tenant: con el token, cualquiera dispara la automatización de un cliente.
const tok = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL';
assert.strictEqual(redactPath(`/hooks/${tok}`), '/hooks/[REDACTED]');
assert.ok(!redactPath(`/hooks/${tok}`).includes(tok), 'ni un trozo del token sobrevive');
assert.ok(esRutaDeHook(`/hooks/${tok}`));

// Y no toca ninguna otra ruta: si tapara de más, los logs dejarían de servir para depurar.
for (const otra of [
  '/automations/cmg7x2k9a0001/hook/regenerate',
  '/webhook/waha',
  '/webhook',
  '/hooks',        // sin token no hay nada que tapar
  '/hooks/',
  '/automations',
  '/',
]) {
  assert.strictEqual(redactPath(otra), otra, otra);
  assert.ok(!esRutaDeHook(otra), otra);
}

console.log('redact.check OK');
