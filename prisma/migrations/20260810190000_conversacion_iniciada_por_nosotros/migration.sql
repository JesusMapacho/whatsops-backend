-- ¿La conversacion la abrimos nosotros escribiendo primero? (v5 feature 30)
--
-- default false y SIN backfill a proposito: todas las conversaciones que existen hoy
-- nacieron de un inbound (el unico camino que habia antes de la feature 29), salvo las
-- pocas creadas por el primer contacto en frio. Marcarlas todas como false hace que
-- ninguna entre en el ciclo de prospeccion, que es el lado seguro: como maximo un
-- operador puede escribir libremente a alguien a quien ya escribio, nunca lo contrario.
ALTER TABLE "Conversation" ADD COLUMN "initiatedByUs" BOOLEAN NOT NULL DEFAULT false;
