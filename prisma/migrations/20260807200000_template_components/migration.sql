-- Variables de plantilla (v5 feature 29).
--
-- Se guardan los `components` CRUDOS de Meta y no un contador de variables: el
-- cuerpo de envío hay que reconstruirlo con la misma forma, y una cabecera puede ser
-- texto, imagen o documento — cosas que un número no distingue. Los parámetros se
-- derivan al leer, así no se quedan viejos tras un sync.
--
-- Nullable sin backfill: las plantillas ya sincronizadas se rellenan solas en el
-- siguiente `POST /templates/sync`. Hasta entonces se comportan como plantillas sin
-- variables, que es exactamente lo que la app soportaba antes de este cambio.

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "components" JSONB;
