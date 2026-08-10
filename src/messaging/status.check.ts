// Check de los destinatarios de un estado. Correr: npx ts-node src/messaging/status.check.ts
import * as assert from 'node:assert';
import { parseContacts } from './status.service';

// El formulario viaja como multipart (lleva archivo), y ahí un solo `contacts` llega
// como string, no como array. Si solo se aceptara array, publicar a UN contacto
// caería en la rama de "no elegiste a nadie".
assert.deepStrictEqual(parseContacts('5218715172350'), ['5218715172350@c.us']);
assert.deepStrictEqual(parseContacts(['5218715172350']), ['5218715172350@c.us']);

// Separadores: salto de línea (pegar una lista), coma y punto y coma.
assert.deepStrictEqual(parseContacts('5218715172350\n5215555555555'), [
  '5218715172350@c.us',
  '5215555555555@c.us',
]);
assert.deepStrictEqual(parseContacts('5218715172350, 5215555555555'), [
  '5218715172350@c.us',
  '5215555555555@c.us',
]);

// Un chatId ya formado se respeta tal cual (no se le reformatea el sufijo).
assert.deepStrictEqual(parseContacts('5215555555555@c.us'), ['5215555555555@c.us']);
// Formato humano con espacios y signos: se quedan solo los dígitos.
// Y NO se inventa el `1` de México: si el operador escribe `+52 871…`, el chatId es
// `52871…`. Meterlo aquí sería adivinar el 521 justo donde no hay a quién preguntar
// (un estado no tiene destinatario que resolver con check-exists).
assert.deepStrictEqual(parseContacts('+52 871 517 2350'), ['528715172350@c.us']);

// Duplicados: publicar dos veces al mismo contacto no hace nada, pero infla el
// recuento de audiencia que queda en el registro.
assert.deepStrictEqual(parseContacts('5215555555555, 521 555 555 5555'), ['5215555555555@c.us']);

// Vacío es vacío — y eso es lo que obliga a marcar "todos mis contactos" a mano en
// vez de publicar a toda la libreta por accidente.
assert.deepStrictEqual(parseContacts(''), []);
assert.deepStrictEqual(parseContacts(undefined), []);
assert.deepStrictEqual(parseContacts(',,\n , '), []);
// Basura sin dígitos no produce un chatId inventado.
assert.deepStrictEqual(parseContacts('hola'), []);

console.log('status.check OK');
