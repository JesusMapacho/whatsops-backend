// Check del lenguajito de `{{...}}` (v10 feature 40). Correr: npx ts-node src/check-all.ts
//
// Lo que protege este archivo, en una frase: que la gramática siga siendo POBRE. Cada assert
// de «esto NO parsea» vale más que los de «esto sí»: en cuanto entra un operador o una ruta
// como argumento, esto deja de ser una tabla de funciones y se convierte en un evaluador de
// expresiones, que es exactamente lo que `code.run` ya es y esto no quiere ser.
import * as assert from 'node:assert';
import { FUNCIONES, LLAVES, aplicar, catalogoDeFunciones, claveSegura, funcionesDesconocidas, parseExpresion, problemasDeFunciones } from './expresiones';

/** Azúcar: parsea y aplica de una, como hace `interpolar`. */
const ev = (dentro: string, valor: unknown) => {
  const e = parseExpresion(dentro);
  return e ? aplicar(valor, e.funciones) : undefined;
};

// --- parseExpresion: lo que SÍ es una expresión ------------------------------------------

assert.deepStrictEqual(parseExpresion('vars.total'), { ruta: 'vars.total', funciones: [] });
assert.deepStrictEqual(
  parseExpresion(' contacto.nombre '),
  { ruta: 'contacto.nombre', funciones: [] },
  'los espacios alrededor se toleran, como antes',
);
assert.deepStrictEqual(parseExpresion('vars.l | cuenta'), {
  ruta: 'vars.l',
  funciones: [{ nombre: 'cuenta', args: [] }],
});
assert.deepStrictEqual(parseExpresion('vars.l | unir:", "'), {
  ruta: 'vars.l',
  funciones: [{ nombre: 'unir', args: [', '] }],
});
assert.deepStrictEqual(
  parseExpresion('a | campo:"x" | campo:"y" | unir:", "')!.funciones.map((f) => f.nombre),
  ['campo', 'campo', 'unir'],
  'se encadenan en orden',
);
assert.deepStrictEqual(
  parseExpresion('a | reemplazar:"a:b":"c"'),
  { ruta: 'a', funciones: [{ nombre: 'reemplazar', args: ['a:b', 'c'] }] },
  'un `:` DENTRO de las comillas no parte el argumento',
);
assert.deepStrictEqual(
  parseExpresion('a | cortar:80'),
  { ruta: 'a', funciones: [{ nombre: 'cortar', args: ['80'] }] },
  'un número va sin comillas',
);
assert.deepStrictEqual(
  parseExpresion('disparador.cuerpo.0.nombre'),
  { ruta: 'disparador.cuerpo.0.nombre', funciones: [] },
  'un índice de array es un segmento con punto, y sigue valiendo',
);

// --- parseExpresion: lo que NO es, que es la parte importante -----------------------------

// EL CASO QUE ABRIÓ LA FEATURE. Es sintaxis de JavaScript, no la nuestra: no parsea, y por
// eso `interpolar` lo deja LITERAL y el editor lo pinta plano. Si algún día esto empieza a
// parsear, el operador va a esperar `.filter(x => x.activo)` a continuación.
assert.strictEqual(parseExpresion("vars.x.habilidades.join(', ')"), null, 'las llamadas a método no son nuestra sintaxis');
assert.strictEqual(parseExpresion('vars.mi campo'), null, 'un espacio dentro de la ruta');
assert.strictEqual(parseExpresion('items[0]'), null, 'los corchetes no');
assert.strictEqual(parseExpresion(''), null, 'unas llaves vacías no son una expresión');
assert.strictEqual(parseExpresion('   '), null, 'ni con espacios');
assert.strictEqual(parseExpresion('| unir'), null, 'sin ruta no hay expresión');
assert.strictEqual(parseExpresion('a | '), null, 'una tubería sin función');
assert.strictEqual(parseExpresion('a | unir:sinComillas'), null, 'un argumento tiene que ser literal o número');
assert.strictEqual(parseExpresion('a | unir:vars.otro'), null, 'una RUTA como argumento no: por ahí se entra a un lenguaje');
assert.strictEqual(parseExpresion('a | unir:"sin cerrar'), null, 'comilla sin cerrar');
assert.strictEqual(parseExpresion('a | Unir'), null, 'los nombres de función son en minúscula');
assert.strictEqual(parseExpresion('a | uni r'), null, 'un espacio dentro del nombre');
assert.strictEqual(parseExpresion('a + b'), null, 'no hay operadores');

// --- Las funciones -----------------------------------------------------------------------

assert.strictEqual(ev('x | unir:", "', ['rayo', 'estática']), 'rayo, estática', 'el caso de la spec');
assert.strictEqual(ev('x | unir:", "', []), '', 'una lista vacía une a vacío');
assert.strictEqual(ev('x | unir', ['a', 'b']), 'a, b', 'sin argumento, separador por defecto');
assert.strictEqual(ev('x | cuenta', ['a', 'b']), 2);
assert.strictEqual(ev('x | primero', ['a', 'b']), 'a');
assert.strictEqual(ev('x | ultimo', ['a', 'b']), 'b');
assert.strictEqual(ev('x | primero', []), null, 'de una lista vacía, nada');
assert.strictEqual(ev('x | mayus', 'ana'), 'ANA');
assert.strictEqual(ev('x | minus', 'ANA'), 'ana');
assert.strictEqual(ev('x | capitalizar', 'ana'), 'Ana');
assert.strictEqual(ev('x | recortar', '  ana  '), 'ana');
assert.strictEqual(ev('x | cortar:3', 'abcdef'), 'abc…');
assert.strictEqual(ev('x | cortar:10', 'abc'), 'abc', 'si cabe, no se toca');
assert.strictEqual(ev('x | reemplazar:"a":"o"', 'cama'), 'como', 'sustituye TODAS');
assert.strictEqual(ev('x | reemplazar:"$&":"!"', 'a$&b'), 'a!b', 'el argumento es literal, no un grupo de reemplazo');

// `por_defecto` es la que convierte el fallo número uno —«Hola , tu pedido»— en algo que el
// operador controla.
assert.strictEqual(ev('x | por_defecto:"amigo"', undefined), 'amigo');
assert.strictEqual(ev('x | por_defecto:"amigo"', null), 'amigo');
assert.strictEqual(ev('x | por_defecto:"amigo"', ''), 'amigo');
assert.strictEqual(ev('x | por_defecto:"amigo"', 'Ana'), 'Ana');
assert.strictEqual(ev('x | por_defecto:"amigo"', 0), 0, 'el cero NO es vacío');
assert.strictEqual(ev('x | por_defecto:"amigo"', false), false, 'ni el falso');

// `campo` es la que evita el `[object Object]` de una API que devuelve objetos.
assert.deepStrictEqual(ev('x | campo:"nombre"', [{ nombre: 'a' }, { nombre: 'b' }]), ['a', 'b']);
assert.strictEqual(
  ev('x | campo:"ability" | campo:"name" | unir:", "', [
    { ability: { name: 'rayo' } },
    { ability: { name: 'estatica' } },
  ]),
  'rayo, estatica',
  'la cadena entera de la spec, que es el caso de los pokemones',
);
assert.strictEqual(ev('x | campo:"nombre"', { nombre: 'a' }), 'a', 'sobre un objeto suelto también');

// --- Nunca lanza, y nunca borra el dato --------------------------------------------------

assert.strictEqual(
  ev('x | fulanito', 'Ana'),
  'Ana',
  'una función que no existe devuelve el valor SIN transformar: el operador se equivocó en el filtro, no en el dato',
);
assert.strictEqual(ev('x | unir:", "', 42), 42, '`unir` sobre un número devuelve el número');
assert.strictEqual(ev('x | cuenta', 'texto'), 'texto', '`cuenta` sobre un texto no inventa un número');
assert.deepStrictEqual(ev('x | mayus', ['a']), ['a'], '`mayus` sobre una lista la devuelve intacta, no "A"');
assert.strictEqual(ev('x | cortar:0', 'abc'), 'abc', 'un argumento absurdo no transforma');
assert.strictEqual(ev('x | cortar:"hola"', 'abc'), 'abc');
for (const v of [undefined, null, 0, false, '', [], {}, 'x']) {
  assert.doesNotThrow(() => {
    for (const nombre of Object.keys(FUNCIONES)) aplicar(v, [{ nombre, args: [] }]);
  }, `ninguna función lanza con ${JSON.stringify(v)}`);
}

// --- La cadena de prototipos, por los DOS caminos ----------------------------------------

assert.ok(!claveSegura('__proto__'));
assert.ok(!claveSegura('constructor'));
assert.ok(!claveSegura('prototype'));
assert.ok(claveSegura('nombre'));

// El agujero nuevo que abre `campo:`: recibe una clave que escribió el operador y hace
// `obj[clave]` por su cuenta, así que NO pasa por el filtro de `valorDe`. Si esto se rompe,
// vuelve el caso por el que `{{x.constructor}}` imprimió código fuente en un mensaje.
for (const malo of ['constructor', '__proto__', 'prototype']) {
  assert.strictEqual(ev(`x | campo:"${malo}"`, { a: 1 }), undefined, `campo:"${malo}" no devuelve nada`);
  assert.strictEqual(ev(`x | campo:"${malo}"`, [{ a: 1 }]), undefined, `ni sobre una lista`);
}

// --- LLAVES: solo delimita, y lo que no parsea se queda literal ---------------------------

const casa = (s: string) => [...s.matchAll(LLAVES)].map((m) => m[1]);
assert.deepStrictEqual(casa('Hola {{a}} y {{b}}'), ['a', 'b'], 'dos en la misma línea');
assert.deepStrictEqual(casa('{{a}'), [], 'una sola llave de cierre no delimita');
assert.deepStrictEqual(casa('{{a\nb}}'), [], 'un salto de línea corta: no son nuestras llaves');
assert.deepStrictEqual(
  casa("{{vars.x.join(', ')}}"),
  ["vars.x.join(', ')"],
  'la regex SÍ lo delimita; es `parseExpresion` quien lo rechaza, y por eso no hay desajuste posible',
);

// --- funcionesDesconocidas: el aviso al activar -------------------------------------------

assert.deepStrictEqual(funcionesDesconocidas('Hola {{a | unir:", "}}'), [], 'las buenas no se avisan');
assert.deepStrictEqual(funcionesDesconocidas('Hola {{a | fulanito}}'), ['fulanito']);
assert.deepStrictEqual(
  funcionesDesconocidas('{{a | fulanito}} y {{b | fulanito}}'),
  ['fulanito'],
  'sin repetir',
);
assert.deepStrictEqual(
  funcionesDesconocidas("{{vars.x.join(', ')}}"),
  [],
  'lo que no parsea no tiene funciones que avisar: se queda literal y el editor lo pinta plano',
);

// --- problemasDeFunciones: la puerta de activar -------------------------------------------

assert.deepStrictEqual(
  problemasDeFunciones([{ type: 'message.send', config: { texto: 'Hola {{a | unir:", "}}' } }]),
  [],
  'un grafo con funciones buenas no da problemas',
);
assert.strictEqual(
  problemasDeFunciones([{ type: 'message.send', config: { texto: 'Hola {{a | fulanito}}' } }]).length,
  1,
);
assert.ok(
  problemasDeFunciones([{ type: 'message.send', config: { texto: '{{a | fulanito}}' } }])[0].includes('message.send'),
  'el problema dice en qué nodo está',
);
assert.ok(
  problemasDeFunciones([{ type: 'x', config: { t: '{{a | fulanito}}' } }])[0].includes('unir'),
  'y qué funciones hay, que es lo que el operador necesita para arreglarlo',
);
assert.strictEqual(
  problemasDeFunciones([{ type: 'logic.condition', config: { campo: 'vars.l | fulanito' } }]).length,
  1,
  'también en el «Campo» de un nodo de lógica, que no lleva llaves',
);
assert.strictEqual(
  problemasDeFunciones([{ type: 'x', config: { casos: [{ valor: '{{a | fulanito}}' }] } }]).length,
  1,
  'y dentro de un array anidado, como los `casos` de un switch',
);
assert.deepStrictEqual(problemasDeFunciones([{ type: 'x', config: null }]), [], 'una config vacía no molesta');
assert.deepStrictEqual(
  problemasDeFunciones([{ type: 'x', config: { t: "{{a.join(', ')}}" } }]),
  [],
  'lo que no parsea no se avisa como función mala: es texto literal, y de eso avisa el resaltado',
);

// --- El catálogo que va al editor ---------------------------------------------------------

const cat = catalogoDeFunciones();
assert.ok(cat.length >= 12, 'las doce de la spec, al menos');
assert.deepStrictEqual(
  cat.map((f) => f.nombre),
  [...cat.map((f) => f.nombre)].sort((a, b) => a.localeCompare(b)),
  'ordenado, que es lo que ve el desplegable',
);
assert.ok(
  cat.every((f) => f.ayuda.trim().length > 0),
  'cada función trae ayuda: un catálogo que nadie encuentra es un catálogo que no existe',
);
assert.deepStrictEqual(
  cat.map((f) => f.nombre).filter((n) => !FUNCIONES[n]),
  [],
  'el catálogo servido no puede ofrecer nada que el motor no sepa aplicar',
);

console.log('expresiones.check OK');
