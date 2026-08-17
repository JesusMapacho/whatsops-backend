// Nombre de la cola en su propio archivo, como `webhook.service.ts` hace con WEBHOOK_QUEUE:
// lo importan el módulo del orquestador, su processor y el del webhook (que solo encola).
// Un import del módulo entero solo para leer un string acabaría en una dependencia circular.
export const AUTOMATION_QUEUE = 'automation-runs';
