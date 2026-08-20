// Check del nodo de código. Correr: npm run check.
//
// Este archivo es la mitad del argumento de seguridad de `codigo.ts`: si alguna de las
// pruebas de aislamiento deja de pasar, el JS de un tenant alcanza el servidor y con él los
// tokens de los demás. No las quites para hacerlo más rápido — lanzan procesos y sí, tardan.
import assert from 'node:assert';
import { ejecutarCodigo } from './codigo';

const CTX = { vars: { peso: '7', zona: 'local' }, ajustes: { precio_kg: '12' }, nodos: {} };

async function fallaCon(codigo: string, parte: string, topeMs?: number) {
  await assert.rejects(
    () => ejecutarCodigo(codigo, CTX, topeMs),
    (e: Error) => {
      assert.match(e.message, new RegExp(parte, 'i'), `esperaba «${parte}» y salió «${e.message}»`);
      return true;
    },
  );
}

async function main() {
  // --- lo que tiene que funcionar ------------------------------------------------------
  assert.strictEqual(await ejecutarCodigo('return 2 + 2', CTX), 4);
  assert.strictEqual(await ejecutarCodigo('return "hola"', CTX), 'hola');
  assert.strictEqual(await ejecutarCodigo('/* sin return */', CTX), null, 'sin return, null y no undefined');

  // El caso real: leer variables del run y constantes del negocio y calcular con ellas.
  assert.deepStrictEqual(
    await ejecutarCodigo(
      `const kg = Number(ctx.vars.peso);
       const base = ctx.vars.zona === 'local' ? 45 : 120;
       const envio = base + Math.max(0, kg - 5) * Number(ctx.ajustes.precio_kg);
       return { envio, comision: Math.round(envio * 0.16) };`,
      CTX,
    ),
    { envio: 69, comision: 11 },
  );

  // Que haya intrínsecos de V8 dentro: sin ellos «algo de programación» no es nada.
  assert.deepStrictEqual(
    await ejecutarCodigo('return [3,1,2].sort().map((n) => n * 2)', CTX),
    [2, 4, 6],
  );
  assert.strictEqual(await ejecutarCodigo('return typeof JSON.parse("{}")', CTX), 'object');

  // --- aislamiento: lo que NO puede alcanzar -------------------------------------------
  // Nada de I/O ni del proceso. El contexto del vm nace vacío, así que estos globales no existen.
  assert.strictEqual(
    await ejecutarCodigo(
      'return [typeof process, typeof require, typeof fetch, typeof globalThis.module].join(",")',
      CTX,
    ),
    'undefined,undefined,undefined,undefined',
    'el código no puede ver el proceso ni pedir módulos',
  );

  // El escape clásico de node:vm. Aunque llegue a `process` (depende de la versión de V8),
  // el hijo corre con `env: {}` y ahí no hay nada que robar: eso es lo que se comprueba.
  const escape = await ejecutarCodigo(
    `try {
       const P = this.constructor.constructor('return process')();
       return { salio: true, claves: Object.keys(P.env).length };
     } catch (e) { return { salio: false, claves: 0 }; }`,
    CTX,
  );
  assert.strictEqual(
    (escape as { claves: number }).claves,
    0,
    'aunque se salga del vm, el proceso hijo no lleva ninguna variable de entorno encima',
  );

  // --- errores, y que ninguno cuelgue el worker ----------------------------------------
  await fallaCon('throw new Error("no me gusta el peso")', 'no me gusta el peso');
  await fallaCon('return (', 'falló'); // error de sintaxis
  // Un bucle infinito lo corta el `timeout` del vm, no el del proceso: el worker sigue vivo.
  await fallaCon('while (true) {}', 'falló|tardó', 300);
  await fallaCon('return "x".repeat(20000)', 'tope');
  await fallaCon('return function () {}', 'no se puede guardar');

  // Y después de todo lo anterior, el siguiente sigue corriendo bien.
  assert.strictEqual(await ejecutarCodigo('return 1', CTX), 1, 'un fallo no deja el runner tocado');

  console.log('codigo: ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
