// Check del merge de reacciones. Correr: npx ts-node src/webhook/mutations.check.ts
import * as assert from 'node:assert';
import { applyReaction } from './mutations';

const ANA = '521555@c.us';
const BETO = '521666@c.us';

// --- Añadir sobre vacío ---
assert.deepStrictEqual(applyReaction(null, ANA, '👍'), { '👍': [ANA] });
assert.deepStrictEqual(applyReaction(undefined, ANA, '👍'), { '👍': [ANA] });
assert.deepStrictEqual(applyReaction({}, ANA, '👍'), { '👍': [ANA] });

// --- Varias personas, mismo emoji ---
const dos = applyReaction({ '👍': [ANA] }, BETO, '👍');
assert.deepStrictEqual(dos, { '👍': [ANA, BETO] });

// --- Una persona solo tiene UNA reacción viva: cambiarla reemplaza la anterior ---
// (Es como funciona WhatsApp; si no, se acumularían emojis del mismo autor.)
assert.deepStrictEqual(applyReaction({ '👍': [ANA] }, ANA, '❤️'), { '❤️': [ANA] });
// Y no afecta a las de los demás.
assert.deepStrictEqual(applyReaction({ '👍': [ANA, BETO] }, ANA, '❤️'), {
  '👍': [BETO],
  '❤️': [ANA],
});

// Repetir el mismo emoji no duplica al autor.
assert.deepStrictEqual(applyReaction({ '👍': [ANA] }, ANA, '👍'), { '👍': [ANA] });

// --- Texto vacío = quitar ---
assert.deepStrictEqual(applyReaction({ '👍': [ANA] }, ANA, ''), {});
// El emoji desaparece del mapa cuando se queda sin nadie (no queda `{'👍': []}`).
assert.deepStrictEqual(applyReaction({ '👍': [ANA, BETO] }, ANA, ''), { '👍': [BETO] });
// Quitar la de alguien que no había reaccionado no toca nada de los demás.
assert.deepStrictEqual(applyReaction({ '👍': [BETO] }, ANA, ''), { '👍': [BETO] });
assert.deepStrictEqual(applyReaction({}, ANA, ''), {});

// --- No muta la entrada ---
const original = { '👍': [ANA] };
applyReaction(original, BETO, '🎉');
assert.deepStrictEqual(original, { '👍': [ANA] }, 'la entrada debe quedar intacta');

// --- Basura en payload.reactions no revienta ni se propaga ---
for (const junk of ['texto', 42, [], { '👍': 'no-es-array' }, { '👍': [1, 2] }]) {
  assert.deepStrictEqual(applyReaction(junk, ANA, '👍'), { '👍': [ANA] });
}

// Sin autor no se puede atribuir: se devuelve lo que había, sin tocar.
assert.deepStrictEqual(applyReaction({ '👍': [ANA] }, '', '❤️'), { '👍': [ANA] });

console.log('mutations.check OK');
