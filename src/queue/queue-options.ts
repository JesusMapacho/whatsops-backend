import { Queue } from 'pg-boss';

// Mismo perfil de reintentos que llevaba `defaultJobOptions` en BullMQ (attempts: 3,
// backoff exponencial arrancando en 1s): retryLimit cuenta REINTENTOS, no intentos totales,
// así que 2 aquí son 3 intentos en total, igual que antes.
export const STANDARD_RETRY: Omit<Queue, 'name'> = {
  retryLimit: 2,
  retryDelay: 1,
  retryBackoff: true,
};

// Un envío en frío NUNCA se reintenta: el POST pudo llegar y perderse la respuesta, y
// escribirle dos veces a un desconocido es lo que hace que te marquen como spam.
export const NO_RETRY: Omit<Queue, 'name'> = {
  retryLimit: 0,
};

// pg-boss programa por cron (minuto es su unidad más fina), así que un intervalo en ms
// configurado libremente (antes vía `repeat: { every }` de BullMQ) se aproxima al minuto
// más cercano. Los valores por defecto de este backend (2 min de reconciliación, 2 min de
// barrido) caen justos en esa rejilla; sub-minuto no es representable y no hace falta serlo
// para un tick de mantenimiento.
export function everyMinutesCron(intervalMs: number): string {
  const minutes = Math.max(1, Math.round(intervalMs / 60_000));
  return minutes === 1 ? '* * * * *' : `*/${minutes} * * * *`;
}
