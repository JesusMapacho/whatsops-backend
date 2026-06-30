// Check del where de auditoría. Correr: npx ts-node src/webhook/webhook-events.check.ts
import * as assert from 'node:assert';
import { buildWebhookEventWhere } from './webhook-events.util';

const T = 'tenant1';

// Sin filtros: tenant propio + no atribuibles.
assert.deepStrictEqual(buildWebhookEventWhere(T, {}), {
  OR: [{ tenantId: T }, { tenantId: null }],
});

// Filtros combinados.
const from = new Date('2026-06-01T00:00:00Z');
const to = new Date('2026-06-30T00:00:00Z');
assert.deepStrictEqual(
  buildWebhookEventWhere(T, {
    type: 'messages',
    processStatus: 'failed',
    signatureValid: true,
    from,
    to,
  }),
  {
    OR: [{ tenantId: T }, { tenantId: null }],
    type: 'messages',
    processStatus: 'failed',
    signatureValid: true,
    createdAt: { gte: from, lte: to },
  },
);

// processStatus inválido se ignora; signatureValid false sí aplica.
const w = buildWebhookEventWhere(T, { processStatus: 'basura', signatureValid: false });
assert.strictEqual('processStatus' in w, false);
assert.strictEqual(w.signatureValid, false);

console.log('webhook-events.check OK');
