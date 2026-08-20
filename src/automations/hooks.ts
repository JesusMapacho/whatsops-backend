// La URL pública de una automatización: `POST /hooks/<token>`. Puro — todo lo que DECIDE si
// un desconocido ejecuta algo vive aquí y se comprueba en hooks.check.ts. Lo impuro (buscar
// la fila, contar en Redis, crear el run) es plomería de cuatro líneas en el servicio.
//
// **Por qué el token va en claro** y no hasheado como `Invitation.tokenHash`:
//   1. El ciclo de vida es el contrario. Una invitación se usa una vez en unos días, y por
//      eso su código acepta que «reenviar es la única salida». Una URL de hook la pega un
//      integrador en un sistema externo y vive años: rotarla ROMPE la integración, así que
//      «se me perdió la URL» tiene que ser una lectura, no un incidente con un tercero. Es
//      lo que hacen n8n, Zapier, GitHub y Slack.
//   2. Alcance del Principio 2 de la constitución: ese principio protege tokens que dan
//      acceso a la cuenta del cliente EN UN TERCERO (`WabaConnection.accessTokenEnc`). Este
//      solo permite disparar una automatización del propio tenant con un cuerpo elegido: no
//      lee datos, no cruza tenants, no toca Meta.
//   3. El hash solo compraría algo frente a una fuga de SOLO LECTURA y parcial. El único
//      lector parcial del sistema es el rol `whatsops_ro` del asistente, y
//      `prisma/sql/assistant-setup.sql` no le da GRANT sobre `Automation`. Quien lee esa
//      tabla entera ya tiene los mensajes, los teléfonos y los tratos del tenant.
//
// Lo que SÍ hubo que arreglar por llevarlo en la ruta: `redactPath` en `observability/
// redact.ts`, o cada 404 dejaba el token en `ErrorLog.path` con `tenantId` nulo.
import { randomBytes } from 'node:crypto';
import { leerTrigger } from './triggers';

export const TOKEN_BYTES = 24;
/** 32 base64url (los nuevos) y también 32 hex (los del backfill de la migración). */
export const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

/**
 * Tope del cuerpo que entra al contexto. Express ya corta en 100 KB por su cuenta; esto es
 * más estricto por el mismo motivo que el recorte de `http.request`: `AutomationRun.context`
 * **se relee entero en cada paso** del run, así que un cuerpo grande lo arrastra por todo el
 * grafo. Coherente con los 16 KB de salida de `code.run`.
 */
export const TOPE_CUERPO_BYTES = 32 * 1024;

/** Por automatización. */
export const TOPE_POR_MINUTO = 60;
/**
 * Por tenant, y no es redundante: la cola de automatizaciones es **compartida entre
 * tenants**, así que un tenant con veinte hooks metería 1200 jobs/min y dejaría a los demás
 * sin worker. Aislar por `tenantId` en las queries no sirve de nada si se agota el recurso
 * común — es la misma lección que ya está escrita en `messaging/limits.ts`.
 */
export const TOPE_TENANT_POR_MINUTO = 300;

export function nuevoTokenDeHook(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Filtro de forma antes de tocar la base, igual que `invitations.porToken`. */
export function pareceToken(v: unknown): v is string {
  return typeof v === 'string' && TOKEN_RE.test(v);
}

export function cuerpoDemasiadoGrande(bytes: number): boolean {
  return bytes > TOPE_CUERPO_BYTES;
}

/** Ventana de un minuto. `a` = por automatización, `t` = por tenant. */
export function claveDeVentana(prefijo: 'a' | 't', id: string, ahoraMs: number): string {
  return `wo:hook:${prefijo}:${id}:${Math.floor(ahoraMs / 60_000)}`;
}

/** Lo que queda de la ventana actual, para el `Retry-After`. Siempre entre 1 y 60. */
export function segundosRestantes(ahoraMs: number): number {
  return 60 - Math.floor((ahoraMs % 60_000) / 1000) || 60;
}

export type VeredictoHook =
  | { ok: true }
  | { ok: false; motivo: 'no-existe' | 'borrador' | 'no-es-webhook' | 'tenant-suspendido' };

/**
 * La tabla de verdad de «¿un desconocido puede disparar esto?». Es la función más importante
 * del camino público y por eso es pura y está comprobada entera.
 */
export function aceptaHook(
  a: { status: string; trigger: unknown; tenantStatus: string } | null,
): VeredictoHook {
  if (!a) return { ok: false, motivo: 'no-existe' };
  if (a.tenantStatus !== 'active') return { ok: false, motivo: 'tenant-suspendido' };
  if (leerTrigger(a.trigger).type !== 'webhook.received') return { ok: false, motivo: 'no-es-webhook' };
  if (a.status !== 'active') return { ok: false, motivo: 'borrador' };
  return { ok: true };
}

/**
 * El estado HTTP de cada veredicto.
 *
 * **404 para casi todo**, para no confirmarle a un desconocido cómo está configurada la cosa.
 * **409 para `borrador`**: quien manda ese POST ya tiene un token de 192 bits, así que
 * distinguir «apagada» de «no existe» no le da nada que no tenga, y un 404 ahí le cuesta una
 * hora de depuración al integrador.
 */
export function estadoDe(motivo: Exclude<VeredictoHook, { ok: true }>['motivo']): 404 | 409 {
  return motivo === 'borrador' ? 409 : 404;
}

/** La URL que se le enseña al operador para copiar. `null` si la automatización no tiene token. */
export function urlDelHook(base: string, token: string | null | undefined): string | null {
  if (!token) return null;
  return `${base.replace(/\/+$/, '')}/hooks/${token}`;
}
