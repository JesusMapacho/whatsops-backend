// Check del TOTP. Correr: npx ts-node src/auth/totp.check.ts
//
// Este archivo es lo que hace defendible haber implementado TOTP a mano: los vectores de
// abajo son los publicados en el RFC 4226 (apéndice D) y el RFC 6238 (§5), no números que
// hayamos sacado de nuestra propia implementación. Si algún día se sustituye por `otplib`,
// estos asserts siguen valiendo tal cual y son la red que dice si el cambio fue correcto.
import * as assert from 'node:assert';
import {
  base32Decode,
  base32Encode,
  codigoHotp,
  codigoTotp,
  contadorTotp,
  generarCodigoRespaldo,
  generarSecreto,
  normalizarCodigoRespaldo,
  uriOtpauth,
  verificarTotp,
  PASO_S,
} from './totp';

// El secreto de los vectores de los RFC: los 20 bytes ASCII "12345678901234567890".
const SECRETO_RFC = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

// --- base32: ida y vuelta ------------------------------------------------------------
assert.strictEqual(
  base32Decode(SECRETO_RFC).toString('ascii'),
  '12345678901234567890',
  'base32 tiene que ser reversible o el secreto guardado no vale nada',
);
assert.strictEqual(base32Encode(Buffer.from('')), '');
assert.strictEqual(base32Encode(Buffer.from('f')), 'MY');
assert.strictEqual(base32Encode(Buffer.from('fo')), 'MZXQ');
assert.strictEqual(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
assert.strictEqual(base32Decode('MZXW6YTBOI').toString(), 'foobar');

// Tolerante con lo que teclea una persona: espacios, guiones, relleno y minúsculas.
assert.deepStrictEqual(base32Decode('mzxw 6ytb-oi='), base32Decode('MZXW6YTBOI'));
// Pero un carácter fuera del alfabeto LANZA, no se trata como cero: un secreto mal
// copiado tiene que fallar al enrolar, no producir códigos que nunca cuadran.
assert.throws(() => base32Decode('MZXW6YTB01'), /base32/, '0 y 1 no están en el alfabeto');

// --- HOTP: vectores del RFC 4226, apéndice D ----------------------------------------
const HOTP_RFC4226 = [
  '755224', '287082', '359152', '969429', '338314',
  '254676', '287922', '162583', '399871', '520489',
];
HOTP_RFC4226.forEach((esperado, contador) => {
  assert.strictEqual(
    codigoHotp(SECRETO_RFC, contador),
    esperado,
    `HOTP del contador ${contador} debe ser ${esperado} (RFC 4226 ap. D)`,
  );
});

// --- TOTP: vectores del RFC 6238, §5 (SHA-1, 8 dígitos) ------------------------------
// Se piden 8 dígitos porque así están publicados; los 6 del producto son estos truncados.
const TOTP_RFC6238: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
];
for (const [segundos, esperado] of TOTP_RFC6238) {
  assert.strictEqual(
    codigoHotp(SECRETO_RFC, contadorTotp(segundos * 1000), 8),
    esperado,
    `TOTP de T=${segundos} debe ser ${esperado} (RFC 6238 §5)`,
  );
  // Y los 6 dígitos del producto son los 6 últimos del vector de 8.
  assert.strictEqual(codigoTotp(SECRETO_RFC, segundos * 1000), esperado.slice(-6));
}

// El contador avanza un paso cada 30 s, y no antes.
assert.strictEqual(contadorTotp(0), 0);
assert.strictEqual(contadorTotp(29_999), 0);
assert.strictEqual(contadorTotp(30_000), 1);

// --- verificarTotp: tolerancia de reloj ---------------------------------------------
const AHORA = 1_700_000_000_000; // instante fijo: nada aquí depende del reloj real
const centro = contadorTotp(AHORA);

assert.strictEqual(
  verificarTotp(SECRETO_RFC, codigoTotp(SECRETO_RFC, AHORA), AHORA),
  centro,
  'el código del momento vale, y devuelve SU contador (no un booleano)',
);
// ±1 paso: el reloj del teléfono desincronizado unos segundos no debe romper el login.
assert.strictEqual(
  verificarTotp(SECRETO_RFC, codigoHotp(SECRETO_RFC, centro - 1), AHORA),
  centro - 1,
  'el paso anterior se acepta',
);
assert.strictEqual(
  verificarTotp(SECRETO_RFC, codigoHotp(SECRETO_RFC, centro + 1), AHORA),
  centro + 1,
  'el paso siguiente se acepta',
);
// Pero no más allá: la ventana es ±30 s, no ±2 minutos.
assert.strictEqual(verificarTotp(SECRETO_RFC, codigoHotp(SECRETO_RFC, centro - 2), AHORA), null);
assert.strictEqual(verificarTotp(SECRETO_RFC, codigoHotp(SECRETO_RFC, centro + 2), AHORA), null);
assert.strictEqual(
  verificarTotp(SECRETO_RFC, codigoHotp(SECRETO_RFC, centro - 4), AHORA),
  null,
  'un código de hace dos minutos NO vale',
);

// --- anti-replay ---------------------------------------------------------------------
// Es la razón por la que `verificarTotp` devuelve el contador. Sin esto, un código visto
// por encima del hombro sirve el resto de su ventana más la tolerancia.
const usado = verificarTotp(SECRETO_RFC, codigoTotp(SECRETO_RFC, AHORA), AHORA);
assert.strictEqual(typeof usado, 'number');
assert.strictEqual(
  verificarTotp(SECRETO_RFC, codigoTotp(SECRETO_RFC, AHORA), AHORA, { minContador: usado! }),
  null,
  'el MISMO código no se puede usar dos veces',
);
// Y el paso anterior tampoco, aunque siga dentro de la tolerancia: ya quedó atrás.
assert.strictEqual(
  verificarTotp(SECRETO_RFC, codigoHotp(SECRETO_RFC, centro - 1), AHORA, { minContador: usado! }),
  null,
  'un contador anterior al último usado se rechaza',
);
// El siguiente paso sí, que es lo que permite volver a entrar en 30 s.
assert.strictEqual(
  verificarTotp(SECRETO_RFC, codigoHotp(SECRETO_RFC, centro + 1), AHORA, { minContador: usado! }),
  centro + 1,
);

// --- forma del código ---------------------------------------------------------------
for (const basura of ['', '12345', '1234567', 'abcdef', '12 34 56', '  123456  ']) {
  assert.strictEqual(
    verificarTotp(SECRETO_RFC, basura, AHORA),
    null,
    `«${basura}» no es un código de 6 dígitos`,
  );
}
assert.strictEqual(verificarTotp(SECRETO_RFC, null as any, AHORA), null);
assert.strictEqual(verificarTotp(SECRETO_RFC, 123456 as any, AHORA), null, 'un número no es un string');

// Otro secreto no abre la misma cuenta.
assert.strictEqual(
  verificarTotp(generarSecreto(), codigoTotp(SECRETO_RFC, AHORA), AHORA),
  null,
);

// --- secretos generados --------------------------------------------------------------
const s1 = generarSecreto();
const s2 = generarSecreto();
assert.notStrictEqual(s1, s2, 'dos secretos seguidos no pueden coincidir');
assert.strictEqual(base32Decode(s1).length, 20, '20 bytes, como recomienda el RFC 4226');
assert.match(s1, /^[A-Z2-7]+$/, 'base32 sin relleno');
// Y un secreto recién generado produce códigos verificables (el ciclo completo).
assert.strictEqual(verificarTotp(s1, codigoTotp(s1, AHORA), AHORA), centro);

// --- URI de enrolamiento ------------------------------------------------------------
const uri = uriOtpauth(SECRETO_RFC, 'ops@whatsops.com');
assert.ok(uri.startsWith('otpauth://totp/'), 'el esquema que entienden las apps');
assert.ok(uri.includes(`secret=${SECRETO_RFC}`));
assert.ok(uri.includes('issuer=WhatsOps'), 'el emisor va también como parámetro, no solo en la etiqueta');
assert.ok(uri.includes(`period=${PASO_S}`) && uri.includes('digits=6') && uri.includes('algorithm=SHA1'));
assert.ok(uri.includes('WhatsOps%3Aops%40whatsops.com'), 'la etiqueta va escapada');

// --- códigos de respaldo ------------------------------------------------------------
const r = generarCodigoRespaldo();
assert.match(r, /^[A-Z2-7]{5}-[A-Z2-7]{5}$/, 'dos grupos de cinco, legibles al dictado');
assert.strictEqual(normalizarCodigoRespaldo(' abcde-fghij '), 'ABCDEFGHIJ');
assert.strictEqual(normalizarCodigoRespaldo(r), r.replace('-', ''));
assert.strictEqual(normalizarCodigoRespaldo(undefined as any), '', 'no lanza con basura');
// Sin caracteres ambiguos al copiarlos de un papel: el alfabeto base32 no trae 0/1/8/9.
assert.ok(!/[0189]/.test(r));
const muchos = new Set(Array.from({ length: 200 }, generarCodigoRespaldo));
assert.strictEqual(muchos.size, 200, 'no se repiten');

console.log('totp: ok');
