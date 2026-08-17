// Orígenes que pueden hablar con la API (v6 feature 32). Antes era `enableCors()` sin
// argumentos —cualquiera—, que con `Authorization: Bearer` era tolerable porque el
// navegador no adjunta la credencial sola; con la sesión en cookie sería justo el agujero
// que la feature 31 viene a cerrar.
export function corsOrigins(): string[] {
  // CORS_ORIGINS (coma-separada) manda; si no está, sirve APP_URL, que ya existe para
  // armar los enlaces de invitación y en la práctica es el mismo valor.
  const raw = process.env.CORS_ORIGINS ?? process.env.APP_URL ?? 'http://localhost:4200';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Comprobación en forma de callback. El decorador `@WebSocketGateway` se evalúa al
 * **importar** el módulo —antes de que ConfigModule cargue el `.env`—, así que la lista no
 * puede resolverse ahí: tiene que mirarse en cada petición. El REST usa la misma para que
 * no haya dos reglas que puedan discrepar.
 *
 * Sin `Origin` (curl, servidor a servidor, la propia página) no hay nada que comparar y
 * tampoco hay riesgo de CSRF de navegador: pasa.
 */
export const corsOriginCheck = (
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
): void => {
  // `=== undefined` y no `!origin`: una cabecera `Origin` vacía es basura, no "sin origen",
  // y el `filter(Boolean)` de arriba garantiza que un '' en la lista no la vuelva comodín.
  cb(null, origin === undefined || corsOrigins().includes(origin));
};
