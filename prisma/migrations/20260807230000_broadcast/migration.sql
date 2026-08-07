-- Envio masivo en frio (v5 feature 29).
CREATE TABLE "Broadcast" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "wabaConnectionId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT,
    "templateName" TEXT,
    "templateLanguage" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "reason" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BroadcastRecipient" (
    "id" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "vars" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "messageId" TEXT,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "BroadcastRecipient_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Broadcast_tenantId_status_idx" ON "Broadcast"("tenantId", "status");
CREATE INDEX "BroadcastRecipient_broadcastId_status_idx" ON "BroadcastRecipient"("broadcastId", "status");
-- Todo el deduplicado del CSV, en una linea: createMany({ skipDuplicates }) se apoya
-- en este unique en vez de recorrer los repetidos a mano.
CREATE UNIQUE INDEX "BroadcastRecipient_broadcastId_phone_key" ON "BroadcastRecipient"("broadcastId", "phone");

ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_wabaConnectionId_fkey" FOREIGN KEY ("wabaConnectionId") REFERENCES "WabaConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;
