// Check de la decisión por destinatario. Correr: npx ts-node src/messaging/broadcast.check.ts
import * as assert from 'node:assert';
import {
  decideRecipient,
  maxRecipients,
  MAX_CONSECUTIVE_FAILURES,
  RecipientCtx,
  sendIntervalMs,
} from './broadcast';

// Caso feliz, del que se derivan los demás cambiando UN campo.
const ok: RecipientCtx = {
  broadcastStatus: 'running',
  recipientStatus: 'pending',
  tenantSuspended: false,
  consecutiveFailures: 0,
  limit: { allowed: true },
  numberExists: true,
};
const con = (over: Partial<RecipientCtx>) => decideRecipient({ ...ok, ...over });

assert.deepStrictEqual(decideRecipient(ok), { action: 'send' });
// Sin comprobar el número (WAHA lento o canal de Meta) se envía igual: un fallo del
// comprobador no debe cancelar el envío.
assert.strictEqual(con({ numberExists: null }).action, 'send');
assert.strictEqual(con({ numberExists: undefined }).action, 'send');

// --- skip: es de ESTE destinatario ---
assert.strictEqual(con({ numberExists: false }).action, 'skip');
// Idempotencia: un job reintentado tras enviar no vuelve a enviar.
assert.strictEqual(con({ recipientStatus: 'sent' }).action, 'skip');
assert.strictEqual(con({ recipientStatus: 'failed' }).action, 'skip');
assert.strictEqual(con({ recipientStatus: 'skipped' }).action, 'skip');
// Y se comprueba ANTES que cualquier aborto: revisar un destinatario ya cerrado no
// puede tumbar el envío entero.
assert.strictEqual(
  con({ recipientStatus: 'sent', broadcastStatus: 'canceled', tenantSuspended: true }).action,
  'skip',
);

// --- abort: para el ENVÍO entero ---
// Cancelar no borra los jobs de Redis; el worker relee el estado y no hace nada.
assert.strictEqual(con({ broadcastStatus: 'canceled' }).action, 'abort');
assert.strictEqual(con({ broadcastStatus: 'paused' }).action, 'abort');
assert.strictEqual(con({ broadcastStatus: 'done' }).action, 'abort');
assert.strictEqual(con({ tenantSuspended: true }).action, 'abort');

// EL TOPE ABORTA, NO SALTA. Es la fila que decide sola que esta tabla exista:
// saltar marcaría 480 destinatarios uno a uno durante una hora, con 480 jobs y 480
// queries que no sirven de nada.
const tope = con({ limit: { allowed: false, message: 'Llegaste al límite de 20 por día.' } });
assert.strictEqual(tope.action, 'abort');
assert.strictEqual((tope as any).reason, 'Llegaste al límite de 20 por día.');

// Fail-CLOSED: no poder medir el cupo para. Aquí nadie espera el mensaje, y un
// contador que falla es justo el síntoma de la ráfaga que queremos parar.
assert.strictEqual(con({ limit: null }).action, 'abort');

// Cortacircuitos: un token caducado falla igual 500 veces.
assert.strictEqual(con({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1 }).action, 'send');
assert.strictEqual(con({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES }).action, 'abort');

// --- Topes e intervalo por canal ---
// WAHA va mucho más bajo: la reputación de la instancia es COMPARTIDA entre tenants.
assert.strictEqual(maxRecipients('waha'), 50);
assert.strictEqual(maxRecipients('whatsapp'), 5000);
assert.ok(maxRecipients('waha') < maxRecipients('whatsapp'));
assert.ok(sendIntervalMs('waha') > sendIntervalMs('whatsapp'));

console.log('broadcast.check OK');
