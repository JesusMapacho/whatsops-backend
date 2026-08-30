// Nombre de la cola en su propio archivo, como `webhook.service.ts` hace con WEBHOOK_QUEUE:
// lo importan el módulo del orquestador, su processor y el del webhook (que solo encola).
// Un import del módulo entero solo para leer un string acabaría en una dependencia circular.
export const AUTOMATION_QUEUE = 'automation-runs';
// Antes vivían en la misma cola de BullMQ, distinguidos por `job.name` ('cron'/'sweep'/'run').
// En pg-boss el nombre del job ES el nombre de la cola, así que cada tipo tiene la suya: los
// disparos programados (`schedule`, persistidos en Postgres) van separados del avance
// ad-hoc de un run (`send`).
export const AUTOMATION_CRON_QUEUE = 'automation-cron';
export const AUTOMATION_SWEEP_QUEUE = 'automation-sweep';
