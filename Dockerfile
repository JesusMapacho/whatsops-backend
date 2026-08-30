# Imagen de la API. Nació cuando el backend y la app se desplegaban por separado
# (`docker compose --profile prod up -d --build`); ahora también sirve para el deploy de
# Heroku en un solo dyno, con el Angular compilado dentro (ver `main.ts` y
# `npm run sync:frontend`): `COPY . .` de más abajo se lleva `public/` si existe en el
# contexto del build, sin que este archivo tenga que saber nada de Angular.
#
# `slim` y no `alpine`: Prisma trae binarios de motor enlazados contra glibc y en musl hay
# que pelearse con `libc6-compat` y las variantes del engine. La imagen es más grande y a
# cambio no hay una tarde perdida. `openssl` se instala explícitamente porque las imágenes
# slim no lo traen y Prisma falla al arrancar con «Unable to detect libssl».
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Las dependencias primero, en su propia capa: cambian mucho menos que el código, así que
# un despliegue normal no vuelve a instalarlas.
COPY package*.json ./
RUN npm ci

# `prisma generate` necesita el esquema, y el build necesita el cliente generado.
COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build && npm prune --omit=dev

# Adjuntos de `LocalDiskStorage`. Va como volumen en compose: sin él, cada `--build` se
# lleva por delante los medios de todos los tenants.
VOLUME /app/storage

ENV NODE_ENV=production
EXPOSE 3000

# Las migraciones se aplican al arrancar. ponytail: con una sola instancia esto es correcto
# y son dos palabras; con varias, dos arranques simultáneos compiten por el lock de
# `_prisma_migrations` (Prisma lo sostiene, pero el segundo falla y reinicia). Techo: sacar
# `migrate deploy` a un paso propio del despliegue el día que haya más de una réplica.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
