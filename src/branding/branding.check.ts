// Check de la validación del color de acento. Correr: npx ts-node src/branding/branding.check.ts
import * as assert from 'node:assert';
import { parseAccentColor } from './branding.util';

// Válidos: hex #rrggbb, normalizado a minúsculas.
assert.strictEqual(parseAccentColor('#0E7C66'), '#0e7c66');
assert.strictEqual(parseAccentColor('#abcdef'), '#abcdef');

// Vacío/nulo → null (limpia el override).
assert.strictEqual(parseAccentColor(null), null);
assert.strictEqual(parseAccentColor(undefined), null);
assert.strictEqual(parseAccentColor(''), null);

// Inválidos: nombres CSS, hex corto, sin #, inyección.
assert.throws(() => parseAccentColor('red'));
assert.throws(() => parseAccentColor('#fff'));
assert.throws(() => parseAccentColor('0e7c66'));
assert.throws(() => parseAccentColor('#0e7c66; background:url(x)'));
assert.throws(() => parseAccentColor(123));

console.log('branding.check OK');
