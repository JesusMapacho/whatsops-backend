-- Constantes del negocio, legibles desde cualquier nodo como {{ajustes.<name>}}.
-- NOTA: escrita a mano y no con `migrate dev`, por el mismo motivo que la migración
-- 20260817180000: la shadow database no se puede crear en este entorno y `migrate dev`
-- proponía RESETEAR la base de desarrollo (ve como drift la tabla `schema_embedding`,
-- que crea prisma/sql/assistant-setup.sql y Prisma no conoce).

-- CreateTable
CREATE TABLE "TenantVariable" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantVariable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantVariable_tenantId_idx" ON "TenantVariable"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantVariable_tenantId_name_key" ON "TenantVariable"("tenantId", "name");

-- AddForeignKey
ALTER TABLE "TenantVariable" ADD CONSTRAINT "TenantVariable_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
