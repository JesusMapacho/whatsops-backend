-- Foto de perfil ya descargada del contacto: key en el storage, no la imagen.
-- La bandeja la sirve con una URL firmada y así no pide una foto por fila a WAHA.
ALTER TABLE "Contact" ADD COLUMN "avatarKey" TEXT;
