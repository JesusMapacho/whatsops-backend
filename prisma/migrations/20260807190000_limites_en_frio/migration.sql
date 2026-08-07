-- Topes de PRIMER CONTACTO (v5 feature 29).
--
-- Índices para las dos consultas nuevas:
--  · conversaciones en frío (lastInboundAt null) en una ventana → tope de primer
--    contacto por tenant.
--  · salientes por CONTACTO en la última hora. Antes se contaba por conversación, y
--    como el worker abre una conversación nueva cuando la anterior está cerrada,
--    bastaba cerrar el hilo para resetear el tope anti-baneo de 4/hora.

-- CreateIndex
CREATE INDEX "Conversation_tenantId_lastInboundAt_idx" ON "Conversation"("tenantId", "lastInboundAt");

-- CreateIndex
CREATE INDEX "Conversation_tenantId_contactId_idx" ON "Conversation"("tenantId", "contactId");
