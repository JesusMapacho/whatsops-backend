// Check del contexto del run (v3 feature 18). Correr: npx ts-node src/automations/contexto.check.ts
import * as assert from 'node:assert';
import { Contexto, NOMBRE_VAR, conSalida, conSalidaYVariable, conVariable, contextoDeMensaje, interpolar, valorDe } from './contexto';

const ctx = contextoDeMensaje({
  texto: 'quiero precio',
  wamid: 'wamid.1',
  contacto: { id: 'c1', nombre: 'Ana', waId: '521999' },
  conversationId: 'conv1',
});

// --- valorDe ---
assert.strictEqual(valorDe(ctx, 'mensaje.texto'), 'quiero precio');
assert.strictEqual(valorDe(ctx, 'contacto.id'), 'c1');
assert.strictEqual(valorDe(ctx, 'no.existe'), undefined, 'ruta ausente → undefined, no lanza');
assert.strictEqual(valorDe(ctx, 'mensaje.texto.mas.hondo'), undefined, 'atravesar un string no lanza');
assert.strictEqual(valorDe(ctx, ''), undefined, 'ruta vacía → undefined');

// --- interpolar ---
assert.strictEqual(interpolar('Hola {{contacto.nombre}}', ctx), 'Hola Ana');
assert.strictEqual(interpolar('Hola {{ contacto.nombre }}', ctx), 'Hola Ana', 'tolera espacios');
// El caso que decide el diseño: una variable que no existe sale VACÍA, no como literal.
assert.strictEqual(interpolar('Hola {{contacto.apodo}}', ctx), 'Hola ');
assert.strictEqual(interpolar('sin variables', ctx), 'sin variables');
assert.strictEqual(interpolar('{{mensaje.texto}} x2 {{mensaje.texto}}', ctx), 'quiero precio x2 quiero precio');

// --- interpolar con funciones (v10 feature 40) ---
//
// La gramática y las funciones se comprueban en `expresiones.check.ts`; aquí lo que se fija es
// cómo se PEGAN al contexto, que es donde estaba el fallo que abrió la feature.
const conLista = conVariable(ctx, 'habilidades', ['rayo', 'estática']);
assert.strictEqual(
  interpolar('Tiene {{vars.habilidades | unir:", "}}', conLista),
  'Tiene rayo, estática',
  'el caso de la spec',
);
assert.strictEqual(
  interpolar('Tiene {{vars.habilidades}}', conLista),
  'Tiene ["rayo","estática"]',
  'SIN función sigue saliendo el JSON, con corchetes y comillas: por eso existe `unir`',
);
assert.strictEqual(
  interpolar('Hola {{contacto.apodo | por_defecto:"amigo"}}', ctx),
  'Hola amigo',
  '`por_defecto` convierte el «Hola , tu pedido» en algo que el operador controla',
);
assert.strictEqual(
  interpolar('Hola {{contacto.nombre | mayus}}', ctx),
  'Hola ANA',
  'una función sobre un valor que sí está',
);
assert.strictEqual(
  interpolar('Hola {{contacto.nombre | fulanito}}', ctx),
  'Hola Ana',
  'una función inexistente NO borra el dato ni para el run',
);

// EL CASO QUE ABRIÓ LA FEATURE, y el que más importa que no cambie sin querer: es sintaxis de
// JavaScript, no la nuestra, así que no parsea y el texto sale LITERAL hacia el cliente. Es
// horrible a propósito, y es exactamente lo que el resaltado del editor pinta plano para
// avisar antes de que lo lea una persona.
assert.strictEqual(
  interpolar("Tiene {{vars.habilidades.join(', ')}}", conLista),
  "Tiene {{vars.habilidades.join(', ')}}",
  'una llamada a método se queda literal, como antes de la feature',
);
assert.strictEqual(
  interpolar('Hola {{vars.mi campo}}', ctx),
  'Hola {{vars.mi campo}}',
  'un espacio en la ruta sigue quedándose literal',
);

// La cadena de prototipos, ahora por el segundo camino: `campo:` recibe una clave que escribió
// el operador y hace `obj[clave]` por su cuenta, sin pasar por el filtro de `valorDe`.
assert.strictEqual(
  interpolar('x{{mensaje | campo:"constructor"}}y', ctx),
  'xy',
  '`campo:"constructor"` no imprime una función ni su código fuente',
);

// --- conSalida ---
const ctx2 = conSalida(ctx, 'n1', { id: 'd1' });
assert.strictEqual(valorDe(ctx2, 'nodos.n1.id'), 'd1');
assert.strictEqual(valorDe(ctx, 'nodos.n1'), undefined, 'no muta el contexto anterior');
const ctx3 = conSalida(ctx2, 'n2', null);
assert.strictEqual(valorDe(ctx3, 'nodos.n1.id'), 'd1', 'conserva las salidas previas');
// Y el contexto se puede volver a leer tras pasar por la columna Json.
assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx3)), ctx3, 'serializable');

// --- conVariable: lo que hace usable la salida de un nodo ---
const v1 = conVariable(ctx, 'cotiza', { precio: 120 });
assert.strictEqual(valorDe(v1, 'vars.cotiza.precio'), 120);
assert.deepStrictEqual(ctx.vars, {}, 'no muta el contexto anterior');
const v2 = conVariable(v1, 'envio', 45);
assert.strictEqual(valorDe(v2, 'vars.cotiza.precio'), 120, 'conserva las anteriores');
assert.strictEqual(valorDe(conVariable(v2, 'envio', 60), 'vars.envio'), 60, 'reescribir pisa el valor');
assert.strictEqual(valorDe(conVariable(ctx, 'x', undefined), 'vars.x'), null, 'undefined se guarda como null');

// Y de nada sirve guardarla si `{{}}` no la alcanza: eso es lo que se comprueba aquí.
assert.strictEqual(interpolar('Son {{vars.cotiza.precio}} pesos', v2), 'Son 120 pesos');
assert.strictEqual(interpolar('{{ajustes.precio_kg}}/kg', { ...v2, ajustes: { precio_kg: '12' } }), '12/kg');
assert.deepStrictEqual(JSON.parse(JSON.stringify(v2)), v2, 'serializable');

// --- NOMBRE_VAR: solo lo que la interpolación puede encontrar ---
for (const bueno of ['total', '_x', 'precio_kg', 'a1']) {
  assert.ok(NOMBRE_VAR.test(bueno), `«${bueno}» debería valer`);
}
// «a.b» partiría la ruta en dos y «mi total» no lo encontraría nunca: ninguno puede pasar.
for (const malo of ['a.b', 'mi total', '1ero', '', 'con-guion', 'ñ']) {
  assert.ok(!NOMBRE_VAR.test(malo), `«${malo}» no debería valer`);
}

// --- disparador: la carga de lo que arrancó el run ---
const kw = contextoDeMensaje({ texto: 'quiero PRECIO', wamid: 'w1', tipo: 'message.keyword', palabra: 'precio' });
assert.strictEqual(valorDe(kw, 'disparador.palabra'), 'precio');
assert.strictEqual(valorDe(kw, 'disparador.tipo'), 'message.keyword');
assert.strictEqual(interpolar('Preguntó por {{disparador.palabra}}', kw), 'Preguntó por precio');
assert.strictEqual(valorDe(ctx, 'disparador.palabra'), null, 'sin palabra, null y no ausente');

// Un cuerpo de webhook es un objeto de fuera: se navega igual, incluido un array en la raíz.
const hook = { disparador: { tipo: 'webhook.received', cuerpo: [{ nombre: 'Ana' }] } };
assert.strictEqual(valorDe(hook, 'disparador.cuerpo.0.nombre'), 'Ana', 'un array se indexa por clave');
assert.strictEqual(valorDe(hook, 'disparador.cuerpo.length'), 1);

// --- la cadena de prototipos NO es contexto ---
// Sin esto, `{{...constructor}}` imprimía el código fuente de una función en un mensaje.
for (const malo of ['constructor', '__proto__', 'prototype']) {
  assert.strictEqual(valorDe(ctx, `mensaje.texto.${malo}`), undefined, malo);
  assert.strictEqual(interpolar(`x{{mensaje.${malo}}}y`, ctx), 'xy', malo);
}

// --- `conSalidaYVariable`: `guardarComo` y `campos` (features 18 y 47) ---
// Es el ÚNICO sitio donde la salida de un nodo se convierte en variables, y lo comparten el
// motor y la simulación en seco. Lo que se afirme aquí vale para los dos.
{
  const base: Contexto = { nodos: {}, vars: {} };
  const salida = { status: 200, json: { data: [{ saldo: 10 }], cliente: { nombre: 'Ana' } } };

  // Sin nada configurado: la salida queda bajo `nodos.<id>` y punto.
  const solo = conSalidaYVariable(base, { id: 'n1', config: {} }, salida);
  assert.deepStrictEqual(valorDe(solo, 'nodos.n1.status'), 200);
  assert.deepStrictEqual(solo.vars, {});

  // `guardarComo` sigue haciendo lo de siempre.
  const conNombre = conSalidaYVariable(base, { id: 'n1', config: { guardarComo: 'api' } }, salida);
  assert.strictEqual(valorDe(conNombre, 'vars.api.json.cliente.nombre'), 'Ana');

  // `campos` nombra trozos, y las rutas son COMPLETAS: se leen sobre el contexto que YA lleva
  // la salida dentro. Por eso no hace falta lógica de prefijo en ninguna capa.
  const conCampos = conSalidaYVariable(
    base,
    {
      id: 'n1',
      config: {
        guardarComo: 'api',
        campos: [
          { nombre: 'saldo', ruta: 'vars.api.json.data.0.saldo' },
          { nombre: 'quien', ruta: 'vars.api.json.cliente.nombre' },
        ],
      },
    },
    salida,
  );
  assert.strictEqual(valorDe(conCampos, 'vars.saldo'), 10, 'el índice de una lista se resuelve');
  assert.strictEqual(valorDe(conCampos, 'vars.quien'), 'Ana');

  // Y una fila de `campos` admite la TUBERÍA, no solo una ruta pelada (§16). No es un lujo: el
  // editor autocompleta funciones en estas filas —lo hace por tipo de campo, no por nodo— así
  // que sin esto sugería algo que el motor tiraba, y la variable salía `null` sin que nada lo
  // dijera. Es el fallo silencioso que el §16 cierra.
  const conTuberia = conSalidaYVariable(
    base,
    {
      id: 'n1',
      config: {
        guardarComo: 'api',
        campos: [
          { nombre: 'cuantos', ruta: 'vars.api.json.data | cuenta' },
          { nombre: 'saldos', ruta: 'vars.api.json.data | campo:"saldo" | unir:", "' },
        ],
      },
    },
    salida,
  );
  assert.strictEqual(valorDe(conTuberia, 'vars.cuantos'), 1);
  assert.strictEqual(valorDe(conTuberia, 'vars.saldos'), '10');
  // Y el JSON entero sigue donde estaba: `campos` AÑADE nombres, no los sustituye.
  assert.strictEqual(valorDe(conCampos, 'vars.api.status'), 200);

  // Una ruta que no resuelve deja la variable a null, no la omite: omitirla haría que
  // `{{vars.x}}` saliera LITERAL en vez de vacío, que es el aviso equivocado.
  const roto = conSalidaYVariable(
    base,
    { id: 'n1', config: { guardarComo: 'api', campos: [{ nombre: 'x', ruta: 'vars.api.json.no.existe' }] } },
    salida,
  );
  assert.strictEqual(valorDe(roto, 'vars.x'), null);
  assert.strictEqual(interpolar('a{{vars.x}}b', roto), 'ab', 'vacío, no literal');

  // La cadena de prototipos tampoco se alcanza por aquí: la ruta la escribe el operador.
  const feo = conSalidaYVariable(
    base,
    { id: 'n1', config: { guardarComo: 'api', campos: [{ nombre: 'p', ruta: 'vars.api.constructor' }] } },
    salida,
  );
  assert.strictEqual(valorDe(feo, 'vars.p'), null);

  // Sin `guardarComo`, una ruta que empieza por `vars.` no resuelve — y es coherente con que
  // sondear sin nombre sea un 400: sin prefijo no hay ruta que elegir.
  const sinNombre = conSalidaYVariable(
    base,
    { id: 'n1', config: { campos: [{ nombre: 'x', ruta: 'vars.api.json.cliente.nombre' }] } },
    salida,
  );
  assert.strictEqual(valorDe(sinNombre, 'vars.x'), null);
}

console.log('contexto.check OK');
