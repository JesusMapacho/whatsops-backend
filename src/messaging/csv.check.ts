// Check del lector de CSV. Correr: npx ts-node src/messaging/csv.check.ts
import * as assert from 'node:assert';
import { parseCsv, parseRecipients } from './csv';

// --- Escáner ---

// Comillas: una coma DENTRO de comillas no parte la celda.
assert.deepStrictEqual(parseCsv('a,"b,c",d')[0].cells, ['a', 'b,c', 'd']);
// "" es una comilla literal.
assert.deepStrictEqual(parseCsv('a,"di ""hola""",c')[0].cells, ['a', 'di "hola"', 'c']);
// CRLF de Excel: el \r no acaba dentro de la última celda.
assert.deepStrictEqual(parseCsv('a,b\r\nc,d').map((r) => r.cells), [
  ['a', 'b'],
  ['c', 'd'],
]);

// Punto y coma: es lo que exporta Excel en español. Sin detectarlo, la fila entera
// entra como UNA celda y la feature parece rota el primer día.
assert.deepStrictEqual(parseCsv('52871;Ana;#1')[0].cells, ['52871', 'Ana', '#1']);
// Y con `;` como separador, la coma es texto normal (decimales).
assert.deepStrictEqual(parseCsv('52871;1,5 kg')[0].cells, ['52871', '1,5 kg']);
// Tabulador (pegar desde Excel).
assert.deepStrictEqual(parseCsv('52871\tAna')[0].cells, ['52871', 'Ana']);
// Sin ningún separador: una sola celda, no un fallo.
assert.deepStrictEqual(parseCsv('52871')[0].cells, ['52871']);

// BOM: Excel lo pone SIEMPRE. Sin quitarlo el primer teléfono no parsea nunca.
assert.deepStrictEqual(parseCsv('﻿52871,Ana')[0].cells, ['52871', 'Ana']);

// --- Destinatarios ---

const basico = parseRecipients('telefono,nombre\n5218715172350,Ana\n5215555555555,Luis\n');
// La cabecera se ignora (no es un número): rechazarla haría creer que el archivo
// está roto, y casi todo CSV exportado la trae.
assert.deepStrictEqual(basico.recipients.map((r) => r.phone), [
  '5218715172350',
  '5215555555555',
]);
assert.deepStrictEqual(basico.recipients[0].vars, ['Ana']);
assert.strictEqual(basico.rejected.length, 0);
// La última línea vacía por el \n final no es un destinatario ni un rechazo.
assert.strictEqual(basico.recipients.length + basico.rejected.length, 2);

// Un archivo SIN cabecera no pierde su primera fila.
assert.strictEqual(parseRecipients('5218715172350,Ana').recipients.length, 1);

// El número de línea del ORIGINAL viaja en el rechazo: "la 3 está mal" se puede
// arreglar, "una fila está mal" no.
const conMalos = parseRecipients('telefono\n5218715172350\n123\n\n5215555555555\n');
assert.strictEqual(conMalos.rejected.length, 1);
assert.strictEqual(conMalos.rejected[0].line, 3);
assert.strictEqual(conMalos.rejected[0].raw, '123');
assert.ok(conMalos.rejected[0].reason.includes('dígitos'));
// La línea 4 en blanco no cuenta como rechazo, y la 5 conserva su número.
assert.strictEqual(conMalos.recipients.length, 2);
assert.strictEqual(conMalos.recipients[1].line, 5);

// Repetidos: colapsan, y se informan. Sin el recuento, el operador ve 12 filas y
// 10 enviados sin saber por qué.
const dup = parseRecipients('52871517235,Ana\n52 871 517 235,Ana otra vez\n5215555555555,Luis');
assert.strictEqual(dup.recipients.length, 2);
assert.strictEqual(dup.duplicates, 1);
// Gana el primero: sus variables son las que se envían.
assert.deepStrictEqual(dup.recipients[0].vars, ['Ana']);

// Un salto de línea DENTRO de comillas no parte la fila, y las líneas siguientes
// conservan su número real.
const multilinea = parseRecipients('5218715172350,"Ana\nMaría"\n5215555555555,Luis');
assert.strictEqual(multilinea.recipients.length, 2);
assert.strictEqual(multilinea.recipients[0].vars[0], 'Ana\nMaría');
assert.strictEqual(multilinea.recipients[1].line, 3);

// Columnas vacías al FINAL: Excel deja separadores de sobra. Sin tirarlas, un
// `52871;Ana;` pediría dos valores a una plantilla que solo tiene uno y el envío
// entero se rechazaría por un punto y coma.
assert.deepStrictEqual(parseRecipients('5218715172350;Ana;;').recipients[0].vars, ['Ana']);
assert.deepStrictEqual(parseRecipients('5218715172350;').recipients[0].vars, []);
// Las de EN MEDIO se conservan: ahí sí falta un dato y el operador tiene que verlo.
assert.deepStrictEqual(parseRecipients('5218715172350;Ana;;#3').recipients[0].vars, [
  'Ana',
  '',
  '#3',
]);

// Excel en español, completo: BOM + `;` + CRLF + cabecera. Es el archivo que de
// verdad va a subir el primer operador.
const excel = parseRecipients('﻿telefono;nombre;folio\r\n5218715172350;Ana;#123\r\n');
assert.strictEqual(excel.recipients.length, 1);
assert.deepStrictEqual(excel.recipients[0].vars, ['Ana', '#123']);

console.log('csv.check OK');
