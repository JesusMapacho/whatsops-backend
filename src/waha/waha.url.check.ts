// Check de la guarda anti-SSRF del baseUrl de WAHA (BYO).
// Correr: npx ts-node src/waha/waha.url.check.ts
// Sin red: los casos válidos usan IP literales, así que no se resuelve DNS.
import * as assert from 'node:assert';
import {
  assertSafeBaseUrl,
  assertSafeFetchUrl,
  isPrivateIp,
  sameOrigin,
  wahaMediaUrl,
} from './waha.url';

// --- Reescritura de la URL de media ---
// WAHA genera la URL con SU vista de si misma (dentro del contenedor,
// `localhost:3000`), que no es la base con la que nosotros la alcanzamos
// (`127.0.0.1:3002`). Comparar origenes rechazaba media legitima (bug observado:
// toda imagen y sticker entrante llegaba con error). Se conserva solo la ruta.
assert.strictEqual(
  wahaMediaUrl('http://localhost:3000/api/files/abc.jpg', 'http://127.0.0.1:3002'),
  'http://127.0.0.1:3002/api/files/abc.jpg',
);
// La query se conserva (WAHA puede firmar la descarga por ahí).
assert.strictEqual(
  wahaMediaUrl('http://localhost:3000/api/files/a.jpg?x-api-key=k', 'http://127.0.0.1:3002'),
  'http://127.0.0.1:3002/api/files/a.jpg?x-api-key=k',
);
// El host del payload NUNCA se honra: aunque apunte a metadata de la nube, la petición
// saldría contra NUESTRA base. Y ahora además la ruta no cuela, así que sale `null`: antes
// esto devolvía `http://127.0.0.1:3002/latest/meta-data/` —inofensivo hacia la nube, pero
// era una petición autenticada a una ruta que elige un tercero.
assert.strictEqual(
  wahaMediaUrl('http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:3002'),
  null,
);
// Sin base o con URL basura no se inventa nada.
assert.strictEqual(wahaMediaUrl('http://x/y', ''), null);
assert.strictEqual(wahaMediaUrl('no-es-url', 'http://127.0.0.1:3002'), null);

// --- ¿A quién se le adjunta la api key? ---
// Las URLs de media vienen DENTRO del payload, o sea que las controla quien opera la
// instancia (con BYO, el tenant). La key solo puede viajar al mismo origen.
assert.ok(sameOrigin('http://waha:3000/api/files/x.jpg', 'http://waha:3000'));

// La ruta del payload también está acotada, no solo el host: sin esto, `fetchPayloadBinary`
// haría un GET a la API de WAHA CON la api key y guardaría la respuesta como adjunto.
assert.strictEqual(
  wahaMediaUrl('http://localhost:3000/api/sessions', 'http://127.0.0.1:3002'),
  null,
  'un endpoint de la API de WAHA no es un archivo',
);
assert.strictEqual(
  wahaMediaUrl('http://localhost:3000/api/t_x/auth/qr', 'http://127.0.0.1:3002'),
  null,
  'el QR de una sesión tampoco',
);
// Travesía relativa: `URL` normaliza el pathname, así que no cuela.
assert.strictEqual(
  wahaMediaUrl('http://localhost:3000/api/files/../sessions', 'http://127.0.0.1:3002'),
  null,
  'los .. los resuelve URL antes de que los veamos',
);
// Y el camino legítimo sigue funcionando (ya afirmado arriba, se repite el borde del
// prefijo exacto: /api/filesX no es /api/files/).
assert.strictEqual(
  wahaMediaUrl('http://localhost:3000/api/filesecretos', 'http://127.0.0.1:3002'),
  null,
);
assert.ok(sameOrigin('http://waha:3000/otra/ruta', 'http://waha:3000/'));
// Puerto, esquema o host distintos = otro origen.
assert.ok(!sameOrigin('http://waha:3001/x', 'http://waha:3000'));
assert.ok(!sameOrigin('https://waha:3000/x', 'http://waha:3000'));
assert.ok(!sameOrigin('http://otro:3000/x', 'http://waha:3000'));
// El caso que importa: una CDN de WhatsApp NO es el mismo origen.
assert.ok(!sameOrigin('https://pps.whatsapp.net/foto.jpg', 'http://waha:3000'));
// Y el clásico de SSRF tampoco.
assert.ok(!sameOrigin('http://169.254.169.254/latest/meta-data/', 'http://waha:3000'));
assert.ok(!sameOrigin('no-es-una-url', 'http://waha:3000'));

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
  // Acepta una URL (para assertSafeBaseUrl) o una promesa ya creada.
  const rejects = (target: string | Promise<unknown>, why: string) =>
    assert.rejects(
      typeof target === 'string' ? () => assertSafeBaseUrl(target) : () => target,
      Error,
      why,
    );

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

  // --- Descarga de URLs del payload ---
  // Mismo origen que la instancia: se adjunta la key (es ella sirviendo el binario).
  assert.deepStrictEqual(
    await assertSafeFetchUrl('http://waha:3000/api/files/x.jpg', 'http://waha:3000'),
    { withKey: true },
  );
  // Otro origen público (CDN legítima): se descarga SIN credencial.
  assert.deepStrictEqual(
    await assertSafeFetchUrl('https://8.8.8.8/foto.jpg', 'http://waha:3000'),
    { withKey: false },
  );
  // Otro origen apuntando hacia dentro: no se toca. Este es el ataque: adjuntar la
  // api key a una petición contra metadata de la nube o un servicio interno.
  await rejects(
    assertSafeFetchUrl('http://169.254.169.254/latest/meta-data/', 'http://waha:3000') as any,
    'metadata de la nube',
  );
  await rejects(
    assertSafeFetchUrl('http://127.0.0.1:6379/', 'http://waha:3000') as any,
    'loopback',
  );
  await rejects(
    assertSafeFetchUrl('http://10.0.0.5/interno', 'http://waha:3000') as any,
    'red privada',
  );
  await rejects(assertSafeFetchUrl('file:///etc/passwd', 'http://waha:3000') as any, 'file://');
  await rejects(assertSafeFetchUrl('basura', 'http://waha:3000') as any, 'URL inválida');
  // Sin baseUrl configurado no se puede considerar "mismo origen" a nada.
  await rejects(assertSafeFetchUrl('http://127.0.0.1/x', '') as any, 'sin baseUrl');

  console.log('waha.url.check OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
