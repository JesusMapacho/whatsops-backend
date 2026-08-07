// Check de la conversión del historial. Correr: npx ts-node src/waha/waha.history.check.ts
import * as assert from 'node:assert';
import { toHistoryRow, usableHistory } from './waha.history';

// --- La trampa del timestamp ---
// WAHA manda SEGUNDOS. Sin multiplicar, new Date(1741249702) es enero de 1970 y el
// historial aparecería medio siglo antes que el resto de la conversación.
const r = toHistoryRow({ id: 'm1', timestamp: 1741249702, from: '5@c.us', body: 'hola' })!;
assert.strictEqual(r.createdAt.getTime(), 1741249702 * 1000);
assert.strictEqual(r.createdAt.getUTCFullYear(), 2025);

// --- Dirección y forma normalizada ---
assert.strictEqual(r.direction, 'in');
assert.strictEqual((r.payload as any).text.body, 'hola');
assert.strictEqual((r.payload as any).imported, true);
assert.strictEqual(
  toHistoryRow({ id: 'm2', timestamp: 1, fromMe: true, body: 'x' })!.direction,
  'out',
);

// --- Media: no se importa el binario, pero se avisa de que falta ---
const media = toHistoryRow({
  id: 'm3',
  timestamp: 1741249702,
  hasMedia: true,
  media: { mimetype: 'image/jpeg' },
})!;
assert.strictEqual(media.type, 'image');
assert.strictEqual((media.payload as any).mediaMissing, true);
// Un mensaje de texto NO lleva la marca de adjunto ausente.
assert.strictEqual((r.payload as any).mediaMissing, undefined);

// --- Autor de grupo y cita ---
assert.deepStrictEqual(
  (toHistoryRow({ id: 'm4', timestamp: 1, participant: '521777@c.us' })!.payload as any).author,
  { waId: '521777@c.us' },
);
assert.strictEqual(
  (toHistoryRow({ id: 'm5', timestamp: 1, replyTo: { id: 'W1' } })!.payload as any).replyToWamid,
  'W1',
);

// --- Basura descartada ---
assert.strictEqual(toHistoryRow({}), null);
assert.strictEqual(toHistoryRow({ timestamp: 1 }), null); // sin id
assert.strictEqual(toHistoryRow(null), null);

// --- usableHistory: solo lo ANTERIOR a lo que ya tenemos ---
const corte = new Date('2026-08-01T00:00:00Z');
const viejo = toHistoryRow({ id: 'a', timestamp: Math.floor(Date.parse('2026-07-01') / 1000) });
const nuevo = toHistoryRow({ id: 'b', timestamp: Math.floor(Date.parse('2026-08-05') / 1000) });
assert.deepStrictEqual(
  usableHistory([viejo, nuevo], corte).map((x) => x.wamid),
  ['a'],
  'lo posterior al corte ya llegó por webhook',
);
// Sin nada previo, todo entra.
assert.strictEqual(usableHistory([viejo, nuevo], null).length, 2);
// Fechas imposibles se descartan (timestamp ausente o 0 → 1970).
assert.deepStrictEqual(usableHistory([toHistoryRow({ id: 'c' })], null), []);
assert.deepStrictEqual(usableHistory([toHistoryRow({ id: 'd', timestamp: 0 })], null), []);
// Los nulos no rompen.
assert.deepStrictEqual(usableHistory([null, viejo, null], corte).length, 1);

console.log('waha.history.check OK');
