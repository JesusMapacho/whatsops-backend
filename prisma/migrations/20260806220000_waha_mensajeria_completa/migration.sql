-- Mensajería completa de WAHA (v5 feature 28): eco del teléfono, reacciones,
-- borrados, citas, notas de voz, grupos e historial.
--
-- Una sola migración a propósito: varios de estos campos los fuerza una feature
-- posterior, y migrar dos veces sobre "Message" (la tabla más grande) es peor.

-- Message.wamid pasa de único GLOBAL a único POR TENANT.
-- Motivo: el id de un mensaje de grupo lo genera el remitente y es IDÉNTICO para
-- todos los destinatarios. Con el unique global, en cuanto dos tenants comparten
-- un grupo, el mensaje del segundo se descarta en silencio (handleInbound dedupe
-- por wamid). Postgres trata los NULL como distintos, así que las filas sin wamid
-- (salientes fallidos) no chocan.
-- DropIndex
DROP INDEX "Message_wamid_key";

-- CreateIndex
CREATE UNIQUE INDEX "Message_tenantId_wamid_key" ON "Message"("tenantId", "wamid");

-- Mensaje borrado por su autor. Columna (no payload) porque se excluye del SQL de
-- no-leídos y de la búsqueda.
-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- Teléfono real: con LID addressing el waId no es un número, y las APIs de
-- historial devuelven @c.us. Sin este eje común se duplicaría el contacto.
-- isGroup: el "contacto" pasa a ser el grupo; el autor de cada mensaje va en
-- Message.payload.author.
-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "phone" TEXT,
                      ADD COLUMN     "isGroup" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Contact_tenantId_phone_idx" ON "Contact"("tenantId", "phone");

-- Versión de la lista de eventos suscritos: la config del webhook se fija al
-- crear la sesión, así que las ya emparejadas hay que re-suscribirlas una vez.
-- AlterTable
ALTER TABLE "WabaConnection" ADD COLUMN     "webhookVersion" INTEGER NOT NULL DEFAULT 0;
