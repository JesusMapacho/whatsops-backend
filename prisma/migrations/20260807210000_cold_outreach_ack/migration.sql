-- Aceptacion explicita del aviso de escribir a desconocidos, por negocio.
-- Nullable sin backfill a proposito: null significa "todavia no acepto", y esa es
-- justo la respuesta correcta para todos los tenants que ya existen.
ALTER TABLE "Tenant" ADD COLUMN "coldOutreachAckedAt" TIMESTAMP(3);
