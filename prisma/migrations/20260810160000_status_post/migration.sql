-- Estados publicados ("historias" de WhatsApp). Solo transporte por QR: la API
-- oficial de Meta no puede publicar estados.
CREATE TABLE "StatusPost" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "wabaConnectionId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT,
    "mediaKey" TEXT,
    "mimeType" TEXT,
    "caption" TEXT,
    "backgroundColor" TEXT,
    "audienceCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusPost_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StatusPost_tenantId_createdAt_idx" ON "StatusPost"("tenantId", "createdAt");

ALTER TABLE "StatusPost" ADD CONSTRAINT "StatusPost_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StatusPost" ADD CONSTRAINT "StatusPost_wabaConnectionId_fkey" FOREIGN KEY ("wabaConnectionId") REFERENCES "WabaConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StatusPost" ADD CONSTRAINT "StatusPost_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
