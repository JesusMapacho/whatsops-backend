// Ejecuta el JavaScript que escribe el operador en el nodo `code.run`. Comprobado en
// codigo.check.ts.
//
// **Por qué un proceso hijo y no `vm` a secas.** Este worker tiene en memoria las
// credenciales de la base y los tokens cifrados de TODOS los tenants, y `node:vm` no es
// una frontera de seguridad: es un aislamiento de *ámbito*, no de *permisos*, y salirse es
// un clásico de una línea (`this.constructor.constructor('return process')()`). El que
// escribe aquí es el admin de UN negocio; que pudiera leer los tokens de los demás sería el
// peor fallo posible del producto.
//
// **Por qué `env: {}` no bastaba.** Era el argumento original y estaba incompleto: escapar
// del vm da un Node entero, con `fs` y con el `cwd` del worker. `readFileSync('.env')`
// entrega ENCRYPTION_KEY —la clave con la que se descifran los `accessTokenEnc` de todos
// los tenants—, JWT_SECRET, DATABASE_URL y WAHA_API_KEY. Vaciar el entorno no sirve si los
// secretos también están en un archivo que el proceso puede leer. De ahí el modelo de
// permisos de Node: sin `--allow-fs-read` no hay disco, y de paso caen `child_process` y
// `worker_threads`. `env: {}` se queda igual, como segunda capa.
//
// **Doble serialización.** El `ctx` entra como literal dentro del programa y el resultado
// sale por `JSON.stringify` DENTRO del vm. Así ningún objeto del host cruza la frontera en
// ninguna de las dos direcciones: pasar un objeto nuestro al vm regalaría su cadena de
// prototipos, y leer un objeto del vm nos haría tocar la suya.
//
// ponytail: un proceso por ejecución (~60 ms) y el runner por `node -e` en vez de un
// archivo suelto (que habría que copiar a dist/ con `assets` en nest-cli.json y resolver
// distinto en dev y en prod). Techo: si esto se llama miles de veces por minuto, un pool de
// hijos reutilizados — y entonces el flag de permisos sigue siendo la parte que no se negocia.
//
// ponytail: el modelo de permisos de Node **no cubre la red**. El hijo aún puede abrir un
// socket a 127.0.0.1 (Redis sin contraseña, Postgres) aunque no tenga credenciales con las
// que autenticarse. Techo aceptado: cerrarlo no es otro flag, es correr el hijo en un
// contenedor sin red. Si algún día importa, ese es el camino.
import { execFile } from 'node:child_process';
import { Contexto } from './contexto';

/** Tope de lo que puede devolver. Va entero a `AutomationRun.context`, que se relee en cada paso. */
const MAX_SALIDA = 16 * 1024;

/** Milisegundos que se le dan al código antes de cortarlo. */
export const TOPE_MS = 1000;

/**
 * El flag del modelo de permisos, que cambió de nombre: `--experimental-permission` en
 * Node 20 y hasta 22.12, `--permission` desde 22.13. Se elige por versión porque pasar el
 * que no existe es `bad option` y **todas** las ejecuciones morirían con exit 9.
 *
 * No hay rama de "este Node no lo soporta": en uno anterior a 20 el hijo no arranca y el
 * nodo falla en vez de correr sin aislamiento. Es la única forma correcta de fallar aquí.
 * `codigo.check.ts` lo comprueba de verdad, preguntándole a `process.permission`.
 */
export function flagDePermisos(version = process.versions.node): string {
  const [major, minor] = version.split('.').map(Number);
  const nuevo = major > 22 || (major === 22 && minor >= 13);
  return nuevo ? '--permission' : '--experimental-permission';
}

// El runner, tal cual se le pasa a `node -e`. Lee `{codigo, ctx, topeMs}` por stdin y
// escribe `{ok, valor}` o `{ok:false, error}` por stdout. En una sola cadena y sin
// dependencias: es lo que hace que no haga falta build ni copiarlo a dist/.
const RUNNER = `
let entrada = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { entrada += c; });
process.stdin.on('end', () => {
  let salida;
  try {
    const { codigo, ctx, topeMs } = JSON.parse(entrada);
    // El ctx entra como literal y el resultado sale ya serializado: nada del host cruza.
    const prog = 'JSON.stringify((function(){"use strict";const ctx=' +
      JSON.stringify(ctx) + ';\\n' + codigo + '\\n})() ?? null)';
    const json = require('vm').runInNewContext(prog, Object.create(null), { timeout: topeMs });
    // Un \`return\` ausente ya salió como 'null' por el \`?? null\` de arriba, así que un
    // undefined aquí solo puede ser JSON.stringify rindiéndose: una función, un símbolo.
    salida = json === undefined
      ? { ok: false, error: 'devolvió algo que no se puede guardar (una función, por ejemplo). Devuelve un número, un texto o un objeto' }
      : { ok: true, json: String(json) };
  } catch (e) {
    salida = { ok: false, error: String((e && e.message) || e) };
  }
  process.stdout.write(JSON.stringify(salida));
});
`;

/**
 * Corre `codigo` con `ctx` disponible y devuelve lo que retorne (ya deserializado).
 *
 * Lanza con un mensaje legible si el código falla, si tarda más de `topeMs` o si devuelve
 * algo más grande que `MAX_SALIDA`. El motor ya convierte eso en un paso `failed` con el
 * texto visible en el panel de ejecuciones.
 */
export function ejecutarCodigo(codigo: string, ctx: Contexto, topeMs = TOPE_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const hijo = execFile(
      process.execPath,
      [flagDePermisos(), '-e', RUNNER],
      // Las dos líneas que hacen segura esta función: el flag de permisos (sin disco, así
      // que un escape del vm no llega al `.env`) y `env: {}` (sin secretos en el entorno).
      // El timeout de aquí es la red de abajo del timeout del vm (que solo corta código
      // síncrono).
      { env: {}, timeout: topeMs + 2000, maxBuffer: MAX_SALIDA * 4, windowsHide: true },
      (err, stdout) => {
        if (err) {
          const porTiempo = (err as NodeJS.ErrnoException).code === 'ETIMEDOUT' || (err as any).killed;
          return reject(new Error(porTiempo ? `El código tardó más de ${topeMs} ms y se cortó.` : `No se pudo ejecutar el código: ${err.message}`));
        }
        let res: { ok?: boolean; json?: string; error?: string };
        try {
          res = JSON.parse(stdout);
        } catch {
          return reject(new Error('El código no devolvió nada legible.'));
        }
        if (!res.ok) return reject(new Error(`El código falló: ${res.error ?? 'sin detalle'}`));
        const json = res.json ?? 'null';
        if (json.length > MAX_SALIDA) {
          return reject(new Error(`El código devolvió ${json.length} caracteres y el tope son ${MAX_SALIDA}. Devuelve solo lo que necesites.`));
        }
        try {
          resolve(JSON.parse(json));
        } catch {
          reject(new Error('El código devolvió algo que no se puede guardar.'));
        }
      },
    );
    hijo.stdin?.end(JSON.stringify({ codigo, ctx, topeMs }));
  });
}
