// Decisión de qué hacer con UN destinatario de un envío masivo. Pura, sin Nest ni
// DB (ver broadcast.check.ts), con la misma forma que `waha.reconcile.ts`: todo el
// criterio en una tabla verificable y el worker limitado a ejecutarla.
//
// La distinción que importa es `skip` vs `abort`:
//   · `skip` es de ESTE destinatario (su número no existe, ya se procesó).
//   · `abort` para el ENVÍO entero. Cuando se alcanza el tope, marcar 480
//     destinatarios uno a uno durante una hora son 480 jobs y 480 queries que no
//     sirven de nada: se pausa y un solo `updateMany` cierra el resto.

// Cortacircuitos: fallos seguidos a partir de los cuales se pausa. Es la diferencia
// entre 3 envíos fallidos y 500 (un token caducado falla igual 500 veces).
export const MAX_CONSECUTIVE_FAILURES = 3;

export type RecipientDecision =
  | { action: 'send' }
  | { action: 'skip'; reason: string }
  | { action: 'abort'; reason: string };

export interface RecipientCtx {
  // running | paused | canceled | done
  broadcastStatus: string;
  // pending | sent | failed | skipped
  recipientStatus: string;
  tenantSuspended: boolean;
  consecutiveFailures: number;
  // Veredicto de `checkLimits` ya calculado, o `null` si NO se pudo calcular.
  limit: { allowed: true } | { allowed: false; message: string } | null;
  // ¿El número existe en WhatsApp? `null` = no se pudo comprobar.
  numberExists?: boolean | null;
}

export function decideRecipient(ctx: RecipientCtx): RecipientDecision {
  // Idempotencia PRIMERO. `jobId = recipient.id` hace que reencolar no duplique,
  // pero BullMQ puede reintentar un job cuyo proceso murió después de enviar.
  // Y va antes que los abortos: revisar un destinatario ya cerrado no debe poder
  // tumbar el envío entero.
  if (ctx.recipientStatus !== 'pending') {
    return { action: 'skip', reason: 'Ya procesado.' };
  }
  // Cancelar no borra jobs de Redis (borrarlos sería una carrera con el worker):
  // el worker relee el estado y no hace nada.
  if (ctx.broadcastStatus !== 'running') {
    return { action: 'abort', reason: 'El envío no está en curso.' };
  }
  if (ctx.tenantSuspended) {
    return { action: 'abort', reason: 'La cuenta está suspendida.' };
  }
  if (ctx.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return {
      action: 'abort',
      reason: `${MAX_CONSECUTIVE_FAILURES} fallos seguidos: envío pausado para revisar.`,
    };
  }
  // Fail-CLOSED: no poder medir el cupo es justo el síntoma de la ráfaga que
  // queremos parar, y aquí nadie está esperando el mensaje.
  if (ctx.limit === null) {
    return { action: 'abort', reason: 'No se pudo verificar el cupo de mensajes en frío.' };
  }
  if (!ctx.limit.allowed) {
    return { action: 'abort', reason: ctx.limit.message };
  }
  // Enviar a números que no existen es una de las señales de spam más fuertes: es
  // literalmente lo que hace un bot recorriendo rangos. `null` (no se pudo
  // comprobar) NO bloquea: un WAHA lento no debe cancelar el envío.
  if (ctx.numberExists === false) {
    return { action: 'skip', reason: 'Ese número no tiene WhatsApp.' };
  }
  return { action: 'send' };
}

// Tope de destinatarios por envío. WAHA va MUCHO más bajo a propósito: un blast en
// frío por WhatsApp Web es exactamente lo que su guía dice que no se haga, y la
// reputación de la instancia es COMPARTIDA entre tenants. Quien necesita miles
// necesita la API oficial.
export function maxRecipients(platform: string): number {
  return platform === 'waha' ? 50 : 5000;
}

// Separación entre envíos. En WAHA imita a una persona escribiendo; en Cloud API es
// solo para no comerse el rate limit de Graph de golpe.
export function sendIntervalMs(platform: string): number {
  return platform === 'waha' ? 8000 : 1000;
}
