// Check de los parámetros de plantilla.
// Correr: npx ts-node src/messaging/template-params.check.ts
import * as assert from 'node:assert';
import {
  buildTemplateComponents,
  templateParams,
  unsupportedTemplateReason,
} from './template-params';

const body = (text: string) => [{ type: 'BODY', text }];

// --- Una variable repetida es UN parámetro ---
// Se deriva del máximo {{n}}, no del número de coincidencias. Contar apariciones
// pediría dos valores para la misma variable.
assert.strictEqual(templateParams(body('Hola {{1}}, otra vez {{1}}')).length, 1);
assert.strictEqual(templateParams(body('Hola {{1}}, tu pedido {{2}}')).length, 2);
assert.strictEqual(templateParams(body('Sin variables')).length, 0);

// --- Huecos en la numeración: no soportada ---
// Rellenar el hueco con vacío produce un mensaje roto a un desconocido.
assert.ok(unsupportedTemplateReason(body('Hola {{1}} y {{3}}')));
assert.match(unsupportedTemplateReason(body('Hola {{1}} y {{3}}'))!, /\{\{2\}\}/);
assert.strictEqual(unsupportedTemplateReason(body('Hola {{1}} y {{2}}')), null);

// --- Parámetros con nombre ---
const named = [
  { type: 'BODY', text: 'Hola {{nombre}}, tu pedido {{folio}} va en camino' },
];
const np = templateParams(named);
assert.strictEqual(np.length, 2);
assert.strictEqual(np[0].name, 'nombre');
assert.strictEqual(np[1].name, 'folio');
// En el envío se llaman `parameter_name`, no posición.
const nb = buildTemplateComponents(np, ['Ana', 'A-123']) as any[];
assert.deepStrictEqual(nb[0].parameters[0], {
  type: 'text',
  parameter_name: 'nombre',
  text: 'Ana',
});
// Un nombre repetido es un solo parámetro.
assert.strictEqual(templateParams(body('{{x}} y otra vez {{x}}')).length, 1);
// Mezclar numerados y nombrados no lo soporta ni Meta.
assert.ok(unsupportedTemplateReason(body('Hola {{1}} y {{nombre}}')));

// --- Cabecera de texto: va ANTES que el cuerpo (es el contrato con la UI) ---
const conHeader = [
  { type: 'HEADER', format: 'TEXT', text: 'Pedido {{1}}' },
  { type: 'BODY', text: 'Hola {{1}}, ya salió' },
];
const hp = templateParams(conHeader);
assert.strictEqual(hp.length, 2);
assert.strictEqual(hp[0].component, 'header');
assert.strictEqual(hp[1].component, 'body');
const hb = buildTemplateComponents(hp, ['A-1', 'Ana']) as any[];
assert.strictEqual(hb[0].type, 'header');
assert.strictEqual(hb[0].parameters[0].text, 'A-1');
assert.strictEqual(hb[1].type, 'body');
assert.strictEqual(hb[1].parameters[0].text, 'Ana');

// --- Cabeceras multimedia: no soportadas (exigen una URL pública por destinatario) ---
for (const format of ['IMAGE', 'DOCUMENT', 'VIDEO', 'LOCATION']) {
  assert.ok(
    unsupportedTemplateReason([{ type: 'HEADER', format }, ...body('x')]),
    `HEADER ${format} debe declararse no soportada`,
  );
}
// Una cabecera de TEXTO sí.
assert.strictEqual(
  unsupportedTemplateReason([{ type: 'HEADER', format: 'TEXT', text: 'Hola' }, ...body('x')]),
  null,
);

// --- Botones ---
const conBotones = [
  { type: 'BODY', text: 'Tu pedido va en camino' },
  {
    type: 'BUTTONS',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Gracias' },
      { type: 'URL', text: 'Ver', url: 'https://x.com/rastreo/{{1}}' },
    ],
  },
];
const bp = templateParams(conBotones);
assert.strictEqual(bp.length, 1);
assert.strictEqual(bp[0].component, 'button');
// El índice es la POSICIÓN del botón en la plantilla (el URL es el segundo → 1).
assert.strictEqual(bp[0].buttonIndex, 1);
const bb = buildTemplateComponents(bp, ['ABC123']) as any[];
assert.strictEqual(bb[0].type, 'button');
assert.strictEqual(bb[0].sub_type, 'url');
// `index` va como STRING. Mandarlo numérico es el fallo clásico → 132xxx.
assert.strictEqual(bb[0].index, '1');
assert.strictEqual(typeof bb[0].index, 'string');

// Botones que no sabemos rellenar → no soportada, en vez de fallar por destinatario.
for (const type of ['COPY_CODE', 'FLOW', 'CATALOG', 'MPM']) {
  assert.ok(
    unsupportedTemplateReason([...body('x'), { type: 'BUTTONS', buttons: [{ type }] }]),
    `botón ${type} debe declararse no soportado`,
  );
}
// QUICK_REPLY y PHONE_NUMBER sí, no llevan parámetros.
assert.strictEqual(
  unsupportedTemplateReason([
    ...body('x'),
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY' }, { type: 'PHONE_NUMBER' }] },
  ]),
  null,
);

// --- Basura no rompe: una plantilla sin variables debe seguir siendo enviable ---
for (const junk of [null, undefined, {}, 'x', [], 42]) {
  assert.deepStrictEqual(templateParams(junk), []);
  assert.strictEqual(unsupportedTemplateReason(junk), null);
}
assert.deepStrictEqual(buildTemplateComponents([], []), []);

// --- Número de valores incorrecto: LANZA ---
// Así el error es un 400 con mensaje claro y no un array corto que Meta rechaza
// destinatario por destinatario.
const dos = templateParams(body('{{1}} {{2}}'));
assert.throws(() => buildTemplateComponents(dos, ['solo-uno']), /necesita 2 valores/);
assert.throws(() => buildTemplateComponents(dos, ['a', 'b', 'c']));

// --- Round-trip contra una forma REAL de Meta ---
// Esta es la aserción que de verdad evita los 132xxx.
const real = [
  { type: 'HEADER', format: 'TEXT', text: 'Pedido {{1}}' },
  { type: 'BODY', text: 'Hola {{1}}, tu pedido {{2}} llega el {{3}}.' },
  { type: 'FOOTER', text: 'Gracias por tu compra' },
  {
    type: 'BUTTONS',
    buttons: [
      { type: 'URL', text: 'Rastrear', url: 'https://envios.mx/{{1}}' },
      { type: 'QUICK_REPLY', text: 'Cancelar' },
    ],
  },
];
const rp = templateParams(real);
// 1 de cabecera + 3 de cuerpo + 1 de botón. El FOOTER nunca lleva parámetros.
assert.strictEqual(rp.length, 5);
assert.deepStrictEqual(
  buildTemplateComponents(rp, ['A-77', 'Ana', 'A-77', 'martes', 'TRK9']),
  [
    { type: 'header', parameters: [{ type: 'text', text: 'A-77' }] },
    {
      type: 'body',
      parameters: [
        { type: 'text', text: 'Ana' },
        { type: 'text', text: 'A-77' },
        { type: 'text', text: 'martes' },
      ],
    },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'TRK9' }] },
  ],
);

console.log('template-params.check OK');
