// Check de los destinatarios de un estado. Correr: npx ts-node src/messaging/status.check.ts
import * as assert from 'node:assert';
import { parseContacts } from './status.service';

// LA ASERCIÓN QUE IMPORTA, y que antes decía lo contrario: este parser devuelve
// DÍGITOS, no un chatId. Pegar `@c.us` a lo que se escribió era un bug observado —
// en México el número que se marca (`52 871…`) no es el wa_id (`521871…`), así que el
// estado salía dirigido a alguien que NO EXISTE, WhatsApp devolvía 201 y no lo veía
// nadie. El canónico lo da `check-exists`, no la aritmética.
assert.deepStrictEqual(parseContacts('+52 871 517 2350'), ['528715172350']);
assert.ok(!parseContacts('+52 871 517 2350')[0].includes('@'));

// El formulario viaja como multipart (lleva archivo), y ahí un solo `contacts` llega
// como string, no como array. Si solo se aceptara array, publicar a UN contacto
// caería en la rama de "no elegiste a nadie".
assert.deepStrictEqual(parseContacts('5218715172350'), ['5218715172350']);
assert.deepStrictEqual(parseContacts(['5218715172350']), ['5218715172350']);

// Separadores: salto de línea (pegar una lista), coma y punto y coma.
assert.deepStrictEqual(parseContacts('5218715172350\n5215555555555'), [
  '5218715172350',
  '5215555555555',
]);
assert.deepStrictEqual(parseContacts('5218715172350, 5215555555555'), [
  '5218715172350',
  '5215555555555',
]);

// Un chatId ya formado se respeta tal cual: quien lo pasa ya sabe lo que hace, y
// `resolveAudience` lo deja pasar sin consultar.
assert.deepStrictEqual(parseContacts('5215555555555@c.us'), ['5215555555555@c.us']);
assert.deepStrictEqual(parseContacts('27943376052448@lid'), ['27943376052448@lid']);

// Duplicados: publicar dos veces al mismo contacto no hace nada, pero infla el
// recuento de audiencia que queda en el registro.
assert.deepStrictEqual(parseContacts('5215555555555, 521 555 555 5555'), ['5215555555555']);

// Vacío es vacío — y eso es lo que obliga a marcar "todos mis contactos" a mano en
// vez de publicar a toda la libreta por accidente.
assert.deepStrictEqual(parseContacts(''), []);
assert.deepStrictEqual(parseContacts(undefined), []);
assert.deepStrictEqual(parseContacts(',,\n , '), []);
// Basura sin dígitos no produce un destinatario inventado.
assert.deepStrictEqual(parseContacts('hola'), []);

console.log('status.check OK');
