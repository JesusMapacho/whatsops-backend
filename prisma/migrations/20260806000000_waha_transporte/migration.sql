-- WAHA (v5 feature 26): WhatsApp por un transporte NO oficial self-hosted
-- (WhatsApp Web vía https://waha.devlike.pro), emparejado por QR.
--
-- Solo ADD VALUE / ADD COLUMN a propósito: Postgres permite añadir valores a un
-- enum dentro de la transacción de la migración pero NO usarlos en ella, así que
-- este archivo no debe llevar ningún INSERT/UPDATE con 'waha' o 'waha_qr'.
--
-- Los uniques existentes ya sirven sin cambios: @@unique([platform, phoneNumberId])
-- separa el namespace de nombres de sesión WAHA del de phone_number_id de Meta,
-- y @@unique([tenantId, platform, waId]) hace lo propio con los chatId '@c.us'.

-- AlterEnum
ALTER TYPE "Platform" ADD VALUE 'waha';

-- AlterEnum
ALTER TYPE "WabaSource" ADD VALUE 'waha_qr';

-- AlterTable
ALTER TABLE "WabaConnection" ADD COLUMN     "baseUrl" TEXT;
