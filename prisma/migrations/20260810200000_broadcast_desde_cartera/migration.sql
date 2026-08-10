-- Destinatario de un envio que sale de una cartera (v5 feature 30).
--
-- Nullable porque el camino del CSV sigue existiendo en los planes de pago y ahi no hay
-- contacto todavia. Presente significa que el waId YA es canonico y el worker no tiene
-- que preguntarlo ni construirlo.
ALTER TABLE "BroadcastRecipient" ADD COLUMN "contactId" TEXT;

CREATE INDEX "BroadcastRecipient_contactId_idx" ON "BroadcastRecipient"("contactId");

ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
