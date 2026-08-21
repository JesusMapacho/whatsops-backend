-- Segundo factor (TOTP) obligatorio para las cuentas de plataforma.
--
-- Todas las columnas son nullable o traen default, así que no toca ninguna fila existente
-- y no hace falta backfill. Las cuentas ya creadas quedan con `totpConfirmedAt` NULL, que
-- es exactamente "tiene que enrolar en su próximo login".
ALTER TABLE "User" ADD COLUMN     "totpSecretEnc" TEXT;
ALTER TABLE "User" ADD COLUMN     "totpConfirmedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN     "totpLastCounter" INTEGER;
ALTER TABLE "User" ADD COLUMN     "totpFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN     "totpLockedUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN     "recoveryCodeHashes" TEXT[];

-- Contacto privado del dueño (§15). El emparejamiento por QR mete todos los chats del
-- teléfono en la bandeja compartida; esto los saca del alcance de los agentes sin cortar
-- la ingesta.
ALTER TABLE "Contact" ADD COLUMN     "privado" BOOLEAN NOT NULL DEFAULT false;
