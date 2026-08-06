// Check de la guarda anti-SSRF del baseUrl de WAHA (BYO).
// Correr: npx ts-node src/waha/waha.url.check.ts
// Sin red: los casos válidos usan IP literales, así que no se resuelve DNS.
import * as assert from 'node:assert';
import { assertSafeBaseUrl, isPrivateIp } from './waha.url';

// --- Rangos que nunca son una instancia legítima de internet ---
for (const ip of [
  '127.0.0.1', // loopback
  '127.1.2.3',
  '0.0.0.0',
  '10.0.0.5', // privada
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.1',
  '169.254.169.254', // metadata de la nube: el objetivo clásico de SSRF
  '100.64.0.1', // CGNAT
  '224.0.0.1', // multicast
  '::1',
  '::',
  'fe80::1', // link-local v6
  'fd00::1', // unique-local v6
  '::ffff:10.0.0.1', // v4 mapeada en v6
]) {
  assert.ok(isPrivateIp(ip), `debe rechazar ${ip}`);
}

// --- Públicas: permitidas ---
for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111']) {
  assert.ok(!isPrivateIp(ip), `debe permitir ${ip}`);
}

// Basura se trata como privada (fail-closed).
assert.ok(isPrivateIp('no-una-ip'));
assert.ok(isPrivateIp('999.1.1.1'));

async function main() {
  const rejects = (url: string, why: string) =>
    assert.rejects(() => assertSafeBaseUrl(url), Error, why);

  // Esquemas y formas inválidas (se rechazan antes de tocar DNS).
  await rejects('file:///etc/passwd', 'file:// no');
  await rejects('gopher://x', 'solo http(s)');
  await rejects('no-es-una-url', 'URL inválida');
  await rejects('http://user:pass@example.com', 'sin credenciales en la URL');

  // Direcciones internas por IP literal.
  await rejects('http://127.0.0.1:3002', 'loopback');
  await rejects('http://169.254.169.254/latest/meta-data/', 'metadata de la nube');
  await rejects('http://10.1.2.3:3000', 'red privada');
  await rejects('http://192.168.0.10', 'red privada');
  await rejects('http://[::1]:3002', 'loopback v6');

  // Normaliza: se queda con esquema + host(+puerto) y tira path y barra final.
  assert.strictEqual(await assertSafeBaseUrl('https://8.8.8.8/'), 'https://8.8.8.8');
  assert.strictEqual(
    await assertSafeBaseUrl('https://8.8.8.8:8443/api/algo'),
    'https://8.8.8.8:8443',
  );

  console.log('waha.url.check OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
