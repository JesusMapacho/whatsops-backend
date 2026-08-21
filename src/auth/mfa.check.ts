// Check de las decisiones del segundo factor. Correr: npx ts-node src/auth/mfa.check.ts
import * as assert from 'node:assert';
import {
  BLOQUEO_MS,
  MAX_FALLOS,
  estaBloqueado,
  etapaTrasPassword,
  requiereSegundoFactor,
  trasIntento,
  UsuarioMfa,
} from './mfa';

const AHORA = 1_700_000_000_000;
const base = (p: Partial<UsuarioMfa> = {}): UsuarioMfa => ({
  isPlatform: false,
  totpConfirmedAt: null,
  totpFailures: 0,
  totpLockedUntil: null,
  ...p,
});

// --- ¿a quién se le exige? ------------------------------------------------------------
assert.strictEqual(requiereSegundoFactor({ isPlatform: true }), true);
assert.strictEqual(requiereSegundoFactor({ isPlatform: false }), false);

// --- etapa tras validar la contraseña -------------------------------------------------
// Un usuario normal entra directo: el segundo factor no se le exige.
assert.deepStrictEqual(etapaTrasPassword(base()), { etapa: 'sesion' });
assert.deepStrictEqual(
  etapaTrasPassword(base({ totpConfirmedAt: new Date(AHORA) })),
  { etapa: 'sesion' },
  'un usuario de tenant con TOTP enrolado igual entra directo: hoy la política no se lo exige',
);

// El de plataforma sin enrolar queda OBLIGADO a enrolar. Es el estado del super-admin
// sembrado por env, así que este es el camino del primer login tras el despliegue.
assert.deepStrictEqual(etapaTrasPassword(base({ isPlatform: true })), { etapa: 'enroll' });

// Con secreto confirmado, se le pide el código.
assert.deepStrictEqual(
  etapaTrasPassword(base({ isPlatform: true, totpConfirmedAt: new Date(AHORA) })),
  { etapa: 'mfa' },
);

// Ninguna etapa de plataforma es 'sesion'. Este assert es el que importa: si alguna vez
// pasa, el segundo factor se puede saltar entrando por la puerta normal.
for (const u of [
  base({ isPlatform: true }),
  base({ isPlatform: true, totpConfirmedAt: new Date(AHORA) }),
  base({ isPlatform: true, totpFailures: 99 }),
  base({ isPlatform: true, totpLockedUntil: new Date(AHORA + 1) }),
]) {
  assert.notStrictEqual(
    etapaTrasPassword(u).etapa,
    'sesion',
    'una cuenta de plataforma NUNCA abre sesión con solo la contraseña',
  );
}

// --- bloqueo ---------------------------------------------------------------------------
assert.strictEqual(estaBloqueado(base(), AHORA), false, 'sin fecha no hay bloqueo');
assert.strictEqual(estaBloqueado({ totpLockedUntil: new Date(AHORA + 1) }, AHORA), true);
assert.strictEqual(
  estaBloqueado({ totpLockedUntil: new Date(AHORA) }, AHORA),
  false,
  'justo al expirar ya se puede intentar',
);
assert.strictEqual(estaBloqueado({ totpLockedUntil: new Date(AHORA - 1) }, AHORA), false);

// --- contador de fallos ----------------------------------------------------------------
assert.deepStrictEqual(trasIntento({ totpFailures: 0 }, false, AHORA), {
  totpFailures: 1,
  totpLockedUntil: null,
});

// Al llegar al tope, bloquea.
assert.deepStrictEqual(trasIntento({ totpFailures: MAX_FALLOS - 1 }, false, AHORA), {
  totpFailures: MAX_FALLOS,
  totpLockedUntil: new Date(AHORA + BLOQUEO_MS),
});

// Acertar limpia TODO. Sin esto, cuatro fallos de hace un mes bloquearían al primer
// dedazo de hoy.
assert.deepStrictEqual(trasIntento({ totpFailures: MAX_FALLOS - 1 }, true, AHORA), {
  totpFailures: 0,
  totpLockedUntil: null,
});
assert.deepStrictEqual(trasIntento({ totpFailures: 0 }, true, AHORA), {
  totpFailures: 0,
  totpLockedUntil: null,
});

// Cinco fallos seguidos desde cero acaban bloqueando, y no antes.
let est = { totpFailures: 0, totpLockedUntil: null as Date | null };
for (let i = 1; i <= MAX_FALLOS; i++) {
  est = trasIntento(est, false, AHORA);
  assert.strictEqual(est.totpFailures, i);
  assert.strictEqual(
    est.totpLockedUntil === null,
    i < MAX_FALLOS,
    `al fallo ${i} el bloqueo debe ${i < MAX_FALLOS ? 'seguir vacío' : 'estar puesto'}`,
  );
}

console.log('mfa: ok');
