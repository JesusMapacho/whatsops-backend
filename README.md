# WhatsOps — API

Backend NestJS + Prisma de WhatsOps: la WhatsApp Cloud API (y el transporte por QR de la
capa gratuita) con multi-tenant, CRM y orquestador detrás.

- **La app** (Angular) vive en su propio repo, `whatsops-frontend`, y se arranca aparte.
- **El diseño, las specs y el contrato** viven en `GW`. Si tienes los tres
  clonados como hermanos, las referencias relativas de las specs (`../GW/…`)
  funcionan tal cual.

## Arranque local

Todo lo de aquí se corre **desde este directorio**: `docker-compose.yml` y `ops/` viven en
este repo, y compose y Nest leen **el mismo `.env`**.

## Prerequisitos
1. **Docker Desktop** corriendo (el daemon debe estar arriba).
2. `cp .env.example .env` y rellenar lo que haga falta. Un solo archivo para los dos:
   Nest lee las variables de la app y compose las de la infra.
3. Para el asistente v1.5 (Rama B), descomentar y rellenar el grupo **Asistente** con tu
   LLM (`LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, `EMBEDDINGS_MODEL`). El
   `DATABASE_URL_RO` ya está puesto y su password coincide con el paso 4.
4. **`COOKIE_SECURE=false`** en `.env` para desarrollo. Desde la v6 la sesión vive en una
   cookie y el navegador **descarta** una cookie `Secure` que llegue por http: sin esto, en
   `http://localhost` el login parece funcionar y la siguiente petición da 401. El arranque
   del backend imprime en qué modo quedó. Ojo: es además el interruptor con el que
   `env.validation.ts` decide si acepta los valores de ejemplo, así que **en producción no
   se pone**.

> `docker-compose.yml` usa `pgvector/pgvector:pg16` (Postgres 16 + extensión `vector`),
> requisito de la Rama B. No usar `postgres:16` liso: `CREATE EXTENSION vector` fallaría.

> ⚠️ **Si la máquina tiene además un PostgreSQL instalado como servicio, el contenedor va
> en otro puerto.** Por eso `POSTGRES_PORT=5433` y `DATABASE_URL=…@127.0.0.1:5433/…`, las
> dos en el mismo `.env`.
>
> Con los dos escuchando el 5432, quién gana depende de si el cliente resuelve IPv4 o IPv6,
> y **el modo en que falla es el peor posible: no falla.** La app trabaja contra la otra
> base sin dar un error — pasó el 2026-08-12 en la máquina de desarrollo, donde el
> instalador de Windows había dejado un `postgresql-x64-18` arrancando solo. Consecuencias
> que costó rato entender: la Rama B nunca podía funcionar (el nativo no tiene `pgvector`,
> ni disponible), y un `docker compose exec postgres psql` —como los pasos 3 y 4 de
> abajo— operaba sobre una base **vacía** devolviendo resultados plausibles.
>
> Cómo comprobar a dónde estás apuntando de verdad:
> `SELECT version(), current_database();` — el contenedor dice `PostgreSQL 16.x … (Debian …)`.
> Si dice `on x86_64-windows`, es el nativo.
>
> Para retirar el nativo (necesita consola de administrador):
> `Stop-Service postgresql-x64-18; Set-Service postgresql-x64-18 -StartupType Manual`.
> Con el nativo fuera, se puede volver a 5432 (en las dos variables).

## Comandos

```bash
# 1. Servicios
docker compose up -d postgres redis

# 2. Esquema base de la app
npx prisma migrate deploy

# 3. Setup del asistente: pgvector + tabla de embeddings + rol RO + RLS.
#    No hay psql en PATH → se usa el del contenedor.
docker compose exec -T postgres psql -U whatsops -d whatsops < prisma/sql/assistant-setup.sql

# 4. Password del rol read-only (ya coincide con DATABASE_URL_RO en .env)
docker compose exec postgres psql -U whatsops -d whatsops \
  -c "ALTER ROLE whatsops_ro WITH LOGIN PASSWORD 'N13p0ENdL4KzMtAtZA5toDWF';"

# 5. Indexar el esquema en pgvector (requiere el LLM/EMBEDDINGS ya puestos)
npx ts-node src/assistant/rag/index-schema.ts   # → "Esquema indexado: N tablas."

# 6. Arrancar la API
npm run start:dev
```

Sin `DATABASE_URL_RO` válido la Rama B queda deshabilitada (el asistente responde
pero no consulta datos). La app Angular se arranca aparte, desde el repo
`whatsops-frontend` (`npm start`, en `http://localhost:4200`), si quieres probar
end-to-end. La API acepta ese origen por `CORS_ORIGINS`.

## WhatsApp por QR (WAHA, capa gratuita v5)

Opcional: solo si quieres probar el transporte no oficial por QR
(el detalle, en `../GW/docs/waha.md`). No necesita nada de Meta.

```bash
docker compose up -d waha

# Comprobar que responde (la api key es WAHA_API_KEY, def. dev-waha-key)
curl -H "X-Api-Key: dev-waha-key" http://localhost:3002/api/sessions

# Y que el backend la alcanza: 'up' = ok, 'down' = no responde o la key no cuadra,
# 'disabled' = faltan las variables en .env
curl http://localhost:3000/health
```

> ⚠️ **`WAHA_URL` debe usar `127.0.0.1`, no `localhost`.** El contenedor se publica
> solo en **loopback IPv4** (`127.0.0.1:3002`, a propósito: la api key es de
> instancia), y en Windows Node resuelve `localhost` a `::1` (IPv6) → el `fetch`
> falla con `ECONNREFUSED` y la UI muestra *"No se pudo contactar la instancia de
> WAHA"*. Ojo: `curl`/`Invoke-RestMethod` con `localhost` **sí** funcionan (prefieren
> IPv4), así que la prueba manual puede pasar y el backend seguir fallando.
>
> **Y lo mismo vale para Postgres**, aunque Docker lo publique en las dos familias: si en
> la máquina hay otro Postgres escuchando, `localhost` puede acabar en él. Usa `127.0.0.1`
> en las dos URLs de base (ver el aviso del principio).
>
> **La api key ya no puede descuadrar.** Vivía en dos `.env` —uno para el contenedor y otro
> para el backend— y si no coincidían la UI decía *"La instancia de WAHA rechazó la api
> key"*. Ahora compose y Nest leen el mismo archivo, así que la clase de fallo desapareció:
> `WAHA_API_KEY` se declara una vez y la usan los dos. Lo mismo con
> `WAHA_WEBHOOK_SECRET`, cuyo descuadre era peor —401 en todos los webhooks y el inbound
> perdido sin un solo error visible—.

Luego, con el backend y el frontend arriba: `/conexiones` → canal
**"WhatsApp (QR)"** → aceptar el aviso de riesgo → Conectar → escanear el QR desde
*WhatsApp › Ajustes › Dispositivos vinculados*. El estado pasa a `WORKING` solo.

Requiere en `.env`: `WAHA_URL`, `WAHA_API_KEY`, `WAHA_CALLBACK_URL` y
`WAHA_WEBHOOK_SECRET` (ver `.env.example`).

> Las dos URLs se confunden con facilidad: `WAHA_URL` la usa el **backend** para
> llamar a WAHA (`http://localhost:3002`), y `WAHA_CALLBACK_URL` la usa **WAHA
> dentro del contenedor** para llamar al backend del host, de ahí
> `http://host.docker.internal:3000/webhook/waha`. Poner `localhost` en la segunda
> apuntaría al propio contenedor y no llegaría ningún mensaje.
>
> El volumen `wahasessions` guarda el estado de emparejamiento. Si lo borras
> (`docker compose down -v`) hay que volver a escanear el QR.

Una vez emparejado, la operación se ve en tres sitios (detalle en `../GW/docs/waha.md`):

```bash
# Estado de las sesiones (gauge de Prometheus)
curl -H "Authorization: Bearer dev-metrics-token" http://localhost:3000/metrics | grep waha_sessions

# Salud (el código HTTP NO depende de WAHA a propósito)
curl http://localhost:3000/health          # → {"status":"ok","waha":"up"}
```

Y en `/platform` (super-admin) la tabla **"Sesiones de WhatsApp por QR"** con el
estado y los salientes de 24 h de cada tenant. Un `docker compose stop waha` y
esperar una pasada de reconciliación (def. 2 min) es la forma rápida de ver que la
deriva se corrige sola.

## Checks del asistente (opcionales, sin BD salvo el último)
```bash
npx ts-node src/assistant/supervisor.check.ts
npx ts-node src/assistant/mutations/branch-a.check.ts
npx ts-node src/assistant/rag/sql-guard.check.ts
npx ts-node src/assistant/rag/executor.check.ts   # integración: requiere DATABASE_URL_RO
```

## Checks de WAHA (sin BD ni red)
```bash
npx ts-node src/webhook/waha.check.ts        # firma sha512, HMAC derivado, acks
npx ts-node src/webhook/mutations.check.ts   # merge de reacciones
npx ts-node src/waha/waha.url.check.ts       # anti-SSRF y reescritura de URLs de media
npx ts-node src/waha/waha.reconcile.check.ts # decisión de reconciliación de sesiones
npx ts-node src/waha/waha.history.check.ts   # conversión del historial (timestamp!)
npx ts-node src/messaging/limits.check.ts    # ritmo y cupo de la capa gratuita
npx ts-node src/webhook/decode.check.ts      # decoders de todos los canales
npx ts-node src/messaging/channels.check.ts  # adaptadores de envío
```

> Si vienes de una conexión creada antes de la feature 28, **elimínala y vuelve a
> emparejar**: el store del engine (que habilita el historial y el asunto de grupo)
> solo puede fijarse al crear la sesión.

## Checks

```bash
npm run check     # los 55 checks del backend, sin BD ni red
```

No hay Jest: cada módulo no trivial deja un `*.check.ts` hermano con `node:assert`, y
`check-all.ts` los corre todos. Un módulo nuevo con lógica y sin check está incompleto.

## Despliegue

La API y la app se despliegan **por separado**, y esa es la razón de que vivan en repos
distintos. Aquí, el `Dockerfile` de al lado más el `docker-compose.yml` que ya usas en
local: `git pull && docker compose up -d --build`.

Las cuatro variables que hacen de contrato con la app, y que en desarrollo no se notan:

| Variable | Valor | Por qué |
|---|---|---|
| `CORS_ORIGINS` | el dominio **de la app**, no de la API | es el origen que esta API acepta |
| `APP_URL` | el dominio de la app | con él se arman los enlaces de invitación |
| `COOKIE_DOMAIN` | el dominio padre común | la cookie de sesión la emite la API y la manda la app: sin esto no viaja entre subdominios |
| `COOKIE_SECURE` | **sin poner** (default `true`) | es además el interruptor con el que `env.validation.ts` rechaza los valores de `.env.example` |

`env.validation.ts` se niega a arrancar si algún secreto sigue con el valor del ejemplo —que
es público por estar en el repo—, así que el primer despliegue falla ruidosamente hasta que
los cambies. Es a propósito.
