-- URL pública por automatización: POST /hooks/<token>.
-- NOTA: escrita a mano y no con `migrate dev`, por el mismo motivo que las migraciones
-- 20260817180000 y 20260819120000: la shadow database no se puede crear en este entorno y
-- `migrate dev` proponía RESETEAR la base (ve como drift la tabla `schema_embedding`, que
-- crea prisma/sql/assistant-setup.sql y Prisma no conoce).

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN "hookToken" TEXT;

-- Backfill. gen_random_uuid() es built-in desde PG13 (no hace falta pgcrypto) y su RNG es
-- criptográfico. 32 hex = 122 bits; los nuevos son 32 base64url = 192. El filtro de forma
-- de `hooks.ts` (TOKEN_RE) acepta los dos a propósito.
UPDATE "Automation" SET "hookToken" = replace(gen_random_uuid()::text, '-', '') WHERE "hookToken" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Automation_hookToken_key" ON "Automation"("hookToken");

-- `webhook.received` cambia de significado: antes era un duplicado de «entra un mensaje» y
-- ahora es una llamada externa. Las que lo usaran dejan de dispararse con WhatsApp, así que
-- se bajan a borrador: mejor que el dueño se entere al abrirlas y no por un cliente.
UPDATE "Automation" SET "status" = 'draft'
WHERE "status" = 'active' AND "trigger"->>'type' = 'webhook.received';
