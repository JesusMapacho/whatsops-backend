// Check de la lógica pura de la Rama A (sin LLM ni BD).
// Correr: npx ts-node src/assistant/mutations/branch-a.check.ts
import * as assert from 'node:assert';
import { isDestructive, assertTool } from './branch-a.service';
import { confirmActions } from '../supervisor';
import type { BranchResult } from '../state';

// ── ¿Destructiva? solo cerrar exige confirmación ─────────────────────────────
assert.strictEqual(isDestructive('setStatus', 'closed'), true);
assert.strictEqual(isDestructive('setStatus', 'open'), false);
assert.strictEqual(isDestructive('setStatus', 'pending'), false);
assert.strictEqual(isDestructive('assign', undefined), false);
assert.strictEqual(isDestructive('addNote', undefined), false);

// ── Allowlist de tools: rechaza lo que no está en el set ─────────────────────
assert.doesNotThrow(() => assertTool('assign'));
assert.doesNotThrow(() => assertTool('setStatus'));
assert.doesNotThrow(() => assertTool('addNote'));
assert.throws(() => assertTool('deleteConversation'), /no permitida/);
assert.throws(() => assertTool('drop'), /no permitida/);

// ── confirmActions: solo la mutación pendiente se vuelve botón de confirmar ───
const results: BranchResult[] = [
  { branch: 'query', ok: true, data: { rows: [] } }, // ignorada
  { branch: 'mutation', ok: false, error: 'boom' }, // ignorada (falló)
  {
    branch: 'mutation',
    ok: true,
    data: { pending: { tool: 'setStatus', conversationId: 'c1', args: { status: 'closed' }, summary: 'cerrar la conversación con Juan' } },
  },
  { branch: 'mutation', ok: true, data: { effect: {}, summary: 'Nota agregada.' } }, // directa: sin confirmación
];
const actions = confirmActions(results);
assert.strictEqual(actions.length, 1);
assert.strictEqual(actions[0].type, 'confirm');
assert.deepStrictEqual(actions[0].confirm, { tool: 'setStatus', conversationId: 'c1', args: { status: 'closed' } });
assert.match(actions[0].label ?? '', /Juan/);

console.log('branch-a.check OK');
