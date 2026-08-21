// Check del where de auditoría. Correr: npx ts-node src/webhook/webhook-events.check.ts
//
// Este archivo es la mitad del argumento de aislamiento: el `WebhookEvent` nace SIN
// tenant (se resuelve en el worker), así que si el where de un tenant llega a incluir
// `tenantId: null`, el admin de cualquier negocio lista los eventos en vuelo de todos
// los demás y lee su `rawPayload` sin redactar. No relajes estos asserts.
import * as assert from 'node:assert';
import { buildWebhookEventWhere, webhookEventScope } from './webhook-events.util';
import { PLATFORM_TENANT_ID } from '../platform/platform.constants';

const T = 'tenant1';

// Un tenant ve EXACTAMENTE los suyos. Ni OR, ni nulos.
assert.deepStrictEqual(buildWebhookEventWhere(T, {}), { tenantId: T });
assert.deepStrictEqual(webhookEventScope(T), { tenantId: T });

// El super-admin es el único que ve los no atribuibles.
assert.deepStrictEqual(webhookEventScope(PLATFORM_TENANT_ID), { tenantId: null });
assert.deepStrictEqual(buildWebhookEventWhere(PLATFORM_TENANT_ID, {}), { tenantId: null });

// Ningún filtro puede reintroducir el alcance perdido: se comprueba sobre el where final.
for (const f of [
  {},
  { type: 'messages' },
  { processStatus: 'pending' },
  { processStatus: 'failed' },
  { signatureValid: false },
  { from: new Date('2026-06-01T00:00:00Z') },
]) {
  const w = buildWebhookEventWhere(T, f) as Record<string, unknown>;
  assert.strictEqual(w.tenantId, T, `el filtro ${JSON.stringify(f)} pisó el alcance`);
  assert.strictEqual('OR' in w, false, 'el where de un tenant no lleva OR');
}

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
    tenantId: T,
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
