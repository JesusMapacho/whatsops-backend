-- Multi-canal (v2 feature 15): platform en conexión, contacto y conversación.

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('whatsapp', 'instagram', 'messenger');

-- DropIndex
DROP INDEX "Contact_tenantId_waId_key";

-- DropIndex
DROP INDEX "WabaConnection_phoneNumberId_idx";

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "platform" "Platform" NOT NULL DEFAULT 'whatsapp';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "platform" "Platform" NOT NULL DEFAULT 'whatsapp';

-- AlterTable
ALTER TABLE "WabaConnection" ADD COLUMN     "platform" "Platform" NOT NULL DEFAULT 'whatsapp';

-- CreateIndex
CREATE UNIQUE INDEX "Contact_tenantId_platform_waId_key" ON "Contact"("tenantId", "platform", "waId");

-- CreateIndex
CREATE UNIQUE INDEX "WabaConnection_platform_phoneNumberId_key" ON "WabaConnection"("platform", "phoneNumberId");
