-- Nombre legible de una conexion. `phoneNumberId` no sirve para identificarla: en WAHA es
-- el nombre de sesion derivado del tenant (t_cmsi4pfjh...), que es lo que se estaba
-- mostrando en los selectores de "enviar desde".
--
-- Nullable y sin backfill: una conexion sin nombre cae al telefono o al id, que es
-- exactamente lo que se mostraba antes.
ALTER TABLE "WabaConnection" ADD COLUMN "label" TEXT;
