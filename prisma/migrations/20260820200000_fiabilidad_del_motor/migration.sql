-- Fiabilidad del motor (v11 feature 41): el candado pasa a sujetar solo la próxima respuesta,
-- y el barrido gana los datos que necesita para liberar lo que se quedó a medias.
-- NOTA: escrita a mano y no con `migrate dev`, por el mismo motivo que las migraciones
-- 20260817180000, 20260819120000 y 20260819170000: la shadow database no se puede crear en
-- este entorno y `migrate dev` proponía RESETEAR la base (ve como drift la tabla
-- `schema_embedding`, que crea prisma/sql/assistant-setup.sql y Prisma no conoce).

-- AlterEnum
-- Va PRIMERO y no se usa en esta migración a propósito: desde PG12 un `ADD VALUE` puede ir en
-- una transacción, pero el valor nuevo no se puede usar hasta que esa transacción cierre.
-- Aquí solo se declara; quien lo escribe es el motor, ya en caliente.
ALTER TYPE "AutomationRunStatus" ADD VALUE 'cortado';

-- DropIndex
-- Hay que soltarlo y recrearlo a mano: se creó como `CREATE UNIQUE INDEX` suelto y no como
-- constraint, así que un `RENAME COLUMN` renombra la columna pero NO el índice, y Prisma
-- vería drift para siempre.
DROP INDEX "AutomationRun_tenantId_activeConversationId_key";

-- AlterTable
ALTER TABLE "AutomationRun" RENAME COLUMN "activeConversationId" TO "waitingConversationId";

-- El cambio de semántica, que es lo que de verdad hace esta migración. La columna significaba
-- «este run está vivo en esta conversación» y ahora significa «este run se queda con la próxima
-- respuesta de esta conversación». Los `waiting` de antes ya cumplían la definición nueva —la
-- única forma de estar `waiting` era «Esperar respuesta»— así que se quedan como están. Los
-- `running` la soltaban al terminar y ahora no la tienen nunca: se limpian aquí.
--
-- Efecto lateral buscado: las conversaciones que hubiera bloqueadas por un run colgado quedan
-- libres en cuanto corre esto, sin tocar nada a mano.
UPDATE "AutomationRun" SET "waitingConversationId" = NULL WHERE "status" <> 'waiting';

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRun_tenantId_waitingConversationId_key" ON "AutomationRun"("tenantId", "waitingConversationId");

-- AlterTable
-- `reanudarEn`: la copia en Postgres del `delay` que vive en Redis, para poder reponer el job
-- si Redis se vacía. `caducaEn`: cuándo se le acaba la paciencia a un «Esperar respuesta».
-- `vecesRevivido`: el tope de reintentos del barrido, para que un run que muere siempre no se
-- re-encole en bucle.
ALTER TABLE "AutomationRun" ADD COLUMN "reanudarEn" TIMESTAMP(3);
ALTER TABLE "AutomationRun" ADD COLUMN "caducaEn" TIMESTAMP(3);
ALTER TABLE "AutomationRun" ADD COLUMN "vecesRevivido" INTEGER NOT NULL DEFAULT 0;
