// Check del contexto del run (v3 feature 18). Correr: npx ts-node src/automations/contexto.check.ts
import * as assert from 'node:assert';
import { conSalida, contextoDeMensaje, interpolar, valorDe } from './contexto';

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

console.log('contexto.check OK');
