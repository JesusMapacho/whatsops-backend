// Check del contexto del run (v3 feature 18). Correr: npx ts-node src/automations/contexto.check.ts
import * as assert from 'node:assert';
import { NOMBRE_VAR, conSalida, conVariable, contextoDeMensaje, interpolar, valorDe } from './contexto';

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

console.log('contexto.check OK');
