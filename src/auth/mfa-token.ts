// El token intermedio: «contraseña correcta, falta el segundo factor». No es una sesión y
// no debe poder usarse como tal.
//
// **Por qué se firma con una clave DERIVADA y no con `JWT_SECRET`.** `JwtAuthGuard` valida
// firma y expiración y **descarta en silencio los claims que no conoce** (copia `sub`,
// `tenantId`, `role`, `roleId` y ya). Así que un token intermedio firmado con el mismo
// secreto pasaría como sesión completamente válida, y lo único que lo impediría sería un
// `if` que alguien tiene que acordarse de escribir y de no borrar.
//
// Derivando la clave, no valida como sesión **por construcción**: el guard no puede
// verificarlo ni queriendo. Mismo truco que `wahaHmacKey` en `webhook/waha.ts`, por el
// mismo motivo — que una credencial no pueda hacerse pasar por otra.
import { createHmac } from 'node:crypto';

/** Vigencia del desafío. Lo justo para abrir la app del teléfono y teclear el código. */
export const DESAFIO_TTL = '5m';

/** Las dos etapas que puede llevar un desafío. Ver `mfa.ts`. */
export type EtapaDesafio = 'enroll' | 'mfa';

export interface DesafioMfa {
  sub: string;
  etapa: EtapaDesafio;
}

/**
 * Clave del desafío, derivada del secreto de sesión.
 *
 * La etiqueta entra en el HMAC para que las dos etapas tengan claves distintas: un token
 * de `enroll` no sirve para `verify` ni al revés. Sin eso, quien tenga un desafío de
 * enrolamiento podría presentarlo donde se valida un código de alguien ya enrolado.
 */
export function claveDesafio(jwtSecret: string, etapa: EtapaDesafio): string {
  return createHmac('sha256', jwtSecret).update(`mfa:${etapa}`).digest('hex');
}
