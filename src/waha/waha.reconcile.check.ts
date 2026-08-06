// Check de la decisión de reconciliación de sesiones WAHA.
// Correr: npx ts-node src/waha/waha.reconcile.check.ts
import * as assert from 'node:assert';
import {
  decideForConnection,
  orphanSessions,
  webhookNeedsUpdate,
  MISSING,
} from './waha.reconcile';

const ok = (status: string) => ({ status, tenantSuspended: false });
const susp = (status: string) => ({ status, tenantSuspended: true });

// --- Coherente: no hay nada que hacer (el caso normal, la gran mayoría) ---
assert.deepStrictEqual(decideForConnection(ok('WORKING'), 'WORKING'), { kind: 'none' });
assert.deepStrictEqual(decideForConnection(ok('SCAN_QR_CODE'), 'SCAN_QR_CODE'), { kind: 'none' });

// --- Estado desincronizado: la fila se pone al día (webhook perdido) ---
assert.deepStrictEqual(decideForConnection(ok('WORKING'), 'SCAN_QR_CODE'), {
  kind: 'update',
  status: 'SCAN_QR_CODE',
});
assert.deepStrictEqual(decideForConnection(ok('STARTING'), 'WORKING'), {
  kind: 'update',
  status: 'WORKING',
});

// --- Sesión muerta: reiniciar. Es el caso que hoy nadie detecta ---
assert.deepStrictEqual(decideForConnection(ok('WORKING'), 'FAILED'), {
  kind: 'restart',
  status: 'FAILED',
});
assert.deepStrictEqual(decideForConnection(ok('WORKING'), 'STOPPED'), {
  kind: 'restart',
  status: 'STOPPED',
});
// Se reintenta aunque la fila ya diga FAILED: el objetivo es que vuelva a vivir.
assert.deepStrictEqual(decideForConnection(ok('FAILED'), 'FAILED'), {
  kind: 'restart',
  status: 'FAILED',
});

// --- La sesión ya no existe en la instancia: marcar, NO recrear ---
assert.deepStrictEqual(decideForConnection(ok('WORKING'), null), {
  kind: 'update',
  status: MISSING,
});
// Y no repetir la escritura en cada pasada una vez marcada.
assert.deepStrictEqual(decideForConnection(ok(MISSING), null), { kind: 'none' });

// --- Tenant suspendido: borrar la sesión (la palanca real de corte) ---
assert.deepStrictEqual(decideForConnection(susp('WORKING'), 'WORKING'), {
  kind: 'delete',
  reason: 'suspended',
});
// Suspendido gana sobre cualquier otro estado, incluido uno muerto.
assert.deepStrictEqual(decideForConnection(susp('WORKING'), 'FAILED'), {
  kind: 'delete',
  reason: 'suspended',
});
// Si ya no hay sesión, no hay nada que borrar.
assert.deepStrictEqual(decideForConnection(susp('WORKING'), null), { kind: 'none' });

// --- Huérfanas: sesión en la instancia sin fila en la DB ---
assert.deepStrictEqual(orphanSessions(['t_a', 't_b'], ['t_a']), ['t_b']);
assert.deepStrictEqual(orphanSessions(['t_a'], ['t_a', 't_b']), []); // falta remota, no huérfana
// Sesiones ajenas (sin nuestro prefijo) no se tocan: la instancia podría compartirse.
assert.deepStrictEqual(orphanSessions(['default', 'otra-app'], []), []);
assert.deepStrictEqual(orphanSessions([], ['t_a']), []);

// --- Re-suscripción de eventos ---
// Se decide por un ENTERO, no comparando listas de eventos: `PUT /api/sessions`
// reinicia la sesión, así que una comparación que no converge (WAHA devolviendo
// los eventos reordenados) reiniciaría toda la flota en cada pasada.
assert.strictEqual(webhookNeedsUpdate(0, 2, 'WORKING'), true, 'versión vieja → re-suscribir');
assert.strictEqual(webhookNeedsUpdate(1, 2, 'WORKING'), true);
assert.strictEqual(webhookNeedsUpdate(2, 2, 'WORKING'), false, 'al día → NO tocar');
// Nunca degradar: una versión futura (rollback del backend) no re-suscribe.
assert.strictEqual(webhookNeedsUpdate(3, 2, 'WORKING'), false);
// Solo sobre sesiones vivas: el PUT arrancaría o fallaría sin motivo en el resto.
assert.strictEqual(webhookNeedsUpdate(0, 2, 'SCAN_QR_CODE'), true);
for (const s of ['STOPPED', 'FAILED', 'STARTING', MISSING, null]) {
  assert.strictEqual(webhookNeedsUpdate(0, 2, s), false, `no re-suscribir en ${s}`);
}
// Idempotencia: llamar dos veces con la versión ya aplicada no vuelve a pedirlo.
assert.strictEqual(webhookNeedsUpdate(2, 2, 'WORKING'), false);

console.log('waha.reconcile.check OK');
