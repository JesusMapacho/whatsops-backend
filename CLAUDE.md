# WhatsOps — API (backend)

La API de WhatsOps: WhatsApp Cloud API y otras plataformas de Meta operando como **Tech
Provider**, más un transporte no oficial por QR (WAHA), con un CRM encima del canal. SaaS
**multi-tenant**.

Este repo es **una capa de dos**. La app Angular vive en `whatsops-frontend` y el diseño,
las specs y el contrato en `GW`. Con los tres clonados como hermanos las
referencias relativas funcionan: `../GW/contrato/NN-slug.md`.

## Antes de trabajar

1. **El contrato** (`../GW/contrato/NN-*.md`) manda sobre la forma de cualquier
   payload que cruce a la app. Si lo que vas a hacer cambia una forma, se edita el contrato
   **primero** y en la misma sesión. Un cambio de forma que no pasó por ahí es un bug de
   proceso, no un atajo.
2. **La spec de esta capa** (`spec/NN-slug.md`, en este repo) trae los pasos, las
   restricciones y la verificación. Su «Definición de hecho» tiene que poder comprobarse
   **sin el frontend levantado**; si no se puede, la sección `## Compatibilidad` del contrato
   está mal escrita.
3. `../GW/DDS.md` es el contrato permanente: sesión en cookie, CSRF, alcance por
   `tenantId`, forma de error, paginación por cursor. Eso no se repite en cada contrato.

## Stack

NestJS (Node/TS) · **PostgreSQL + Prisma** · **Redis + BullMQ** · WebSocket (Socket.IO).
**Monolito modular**, no microservicios.

**Toda la API cuelga de `/api`** (`app.setGlobalPrefix('api')`, `main.ts`). Existe para que
este mismo proceso pueda servir además el `index.html` compilado de Angular (`public/`, vía
`app.useStaticAssets` + un fallback de ruta comodín) sin que la ruta comodín del SPA se
coma un endpoint de la API — con ~20 grupos de rutas en la raíz no hay otra forma barata de
separarlos. Ver «Despliegue» en `README.md` para las dos formas de desplegar (un solo
origen en Heroku, o API y app en dominios distintos como antes).

## Principios que no se rompen

De `../GW/constitution/constitution.md`; aquí están los que restringen código:

- **Multi-tenant desde el día 1.** Todo dato vive bajo `tenantId`; ninguna query cruza
  tenants. No es una convención: es la propiedad que sostiene el producto.
- **Los tokens son secretos.** Se validan al guardarse, se cifran en reposo (AES-256-GCM,
  `CryptoService`) y **nunca** se loguean. `redact.ts` tapa por substring.
- **El webhook nunca procesa inline.** Verifica firma → encola en BullMQ → responde 200. El
  trabajo real va en workers, con reintentos y *replay*.
- **Las reglas de Meta se deciden por adaptador, nunca a mano.** La ventana de 24 h y las
  plantillas son obligatorias en el transporte **oficial**; la capa gratuita queda fuera y por
  eso el freno cuelga de `adapter.enforcesWindow`. Un `if` con el nombre de un canal dentro es
  la forma de equivocarse aquí.
- **Simplicidad antes que features.** La complejidad se agrega cuando una necesidad real y
  medida lo exige, no antes.

## Convenciones

**No hay Jest.** Cada módulo no trivial deja un `*.check.ts` hermano con `node:assert`, y
`npm run check` los corre todos (55 hoy). Un módulo con lógica y sin check está incompleto.
Los checks no tocan base ni red: lo que necesita base se prueba a mano y se dice en la spec.

**Los `build*Where` son el sitio donde se pierde el aislamiento.** El error de la familia es
un filtro que **asigna** la clave del alcance y con eso lo borra: `{ ...base, AND: extra }`
pisa el `AND` que traía el alcance, así que teclear una letra en un buscador abría la bandeja
entera. Los filtros se **suman** a lo que ya hay, y el check lo afirma sobre el `where`
**final**, recorriendo combinaciones — no sobre las piezas por separado.

**Fronteras que conviene no volver a mezclar:**

- `messaging/lifecycle.ts` decide *¿puedo escribirle a **esta persona** ahora?* y
  `messaging/limits.ts` *¿cuánto puede mandar **este tenant** en total?*. Son dos preguntas y
  dos archivos.
- **`Stage` no es `lifecycle.ts`**: uno es el punto de la venta, que configura el negocio; el
  otro el freno anti-baneo, que se deriva.
- **La etiqueta no es la cartera**: la cartera decide a quién le envío y **autoriza**; la
  etiqueta describe y filtra, y no autoriza nada.

**Deuda con `ponytail:`.** Un atajo deliberado se marca con un comentario que nombra el techo
y el camino de mejora. Sin techo escrito no es un atajo, es un descuido.

## Lo que este repo sabe del otro

Dos acoplamientos hacia la app, y ahora viven en repos distintos:

- `assistant/synthesis.ts` devuelve **rutas de navegación de Angular** (`/bandeja`). Si allí
  se renombra una ruta, el asistente manda al usuario a un 404 y nada lo detecta.
- `invitations.service.ts` arma enlaces de la app con `APP_URL` — son rutas de Angular, no
  de esta API, así que no llevan `/api`.

Los dos son datos de la frontera. Si cambian, van al contrato.

## Local

Ver `README.md`. `docker compose up -d` (postgres, redis, waha, prometheus, grafana) y
`npm run start:dev`; compose y Nest leen el mismo `.env`.
