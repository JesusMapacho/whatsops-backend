# 45-backend — Métricas de automatizaciones

**Objetivo:** agregar las ejecuciones de `AutomationRun` en cubos de día natural por flujo, y
servirlas en una ruta propia.
**Contrato:** `../GW/contrato/45-metricas-de-automatizaciones.md` §Formas
**Depende de:** `automations/automations.service.ts`, `crm/tasks.buckets.ts`.
**Definición de hecho:** `GET /automations/metrics` devuelve una entrada por cada
automatización del tenant —incluidas las que nunca corrieron—, con la serie de N días en la
zona del negocio y los tres contadores terminales, y `npm run check` pasa entero.

## Por qué así

El dato ya estaba todo en `AutomationRun` (`status`, `createdAt`, `automationId`,
`tenantId`); lo único que faltaba era la agregación. `GET /automations` daba `_count: { runs,
nodes }`, que es el total histórico: no distingue un éxito de un fallo, no tiene fecha y no
tiene serie. Con eso no se puede contestar «¿esto funciona?», que es la pregunta con la que
se abre la pantalla.

La ruta va aparte, un flujo sin ejecuciones sale igual, `running`/`waiting` cuentan en la
serie pero no en los contadores, y los cubos son días naturales del negocio: **eso es del
contrato, §Lo que NO cruza la frontera, y aquí no se vuelve a argumentar.**

> Se decidió **en contra** de meterlo como un campo más en `GET /automations`. Es lo obvio
> —una consulta menos, un `include` más— y es exactamente lo que ata la pantalla desde la que
> se apaga un flujo que está mandando algo mal a una consulta cara. El argumento entero está
> en el contrato.

> Se decidió **en contra** de `groupBy` de Prisma para los cubos, al revés que
> `crm/kpis.service.ts`. Prisma no sabe agrupar por un día derivado, así que la alternativa
> era traerse los runs a memoria y cubearlos en JS: una consulta sin tope, que crece con las
> ejecuciones del tenant. El motivo por el que `kpis.service.ts` huyó del SQL crudo —componer
> un alcance con `OR` a mano— aquí no aplica: el alcance es un `"tenantId" = $1` literal, sin
> nada que pisar.

## La aritmética — `automations/metricas.ts`

Puro, con `metricas.check.ts` al lado. Todo lo que toca base se queda en el servicio, porque
los checks no levantan Postgres y la aritmética de días es justo lo que hay que poder probar.

- `parseDias(v)` — acota a 1..30, por defecto 7. Cero, negativo y basura caen al default,
  como `Number(limit) || 20` en `runs()`.
- `zonaValida(tz)` — la zona del tenant o `'UTC'`. Existe porque los dos lados la tratan
  distinto: `diaEn` cae a UTC sola ante una zona inválida, pero un `AT TIME ZONE` de Postgres
  con la misma basura **lanza**. Validar una vez y pasar el mismo valor a los dos es lo que
  impide que los cubos los corte Postgres con una zona y las claves las genere el proceso con
  otra — que sería una serie desalineada en vez de un error visible.
- `ventana(ahora, dias, tz)` — las claves `YYYY-MM-DD` de la ventana, viejo → nuevo, más la
  medianoche de la más antigua como instante UTC para el `WHERE`.
- `armar(ids, filas, claves, ultimas)` — las filas agregadas → los `flujos` de la respuesta.

`ventana` retrocede **re-anclando**, no restando 24 h: el día del cambio de horario de verano
dura 23 o 25 horas, así que un día fijo desvía el corte una hora y acaba repitiendo o
saltándose una fecha. Doce horas hacia atrás desde una medianoche caen siempre dentro del día
anterior, y a ese instante se le vuelve a pedir su medianoche. Es el mismo razonamiento —y el
mismo truco— que `crm/tasks.buckets.ts:91-98` usa hacia delante.

La zona horaria **no se reimplementa**: `diaEn` e `inicioDelDia` salen de
`crm/tasks.buckets.ts`. Sí, `automations` importando de `crm`; la alternativa era un tercer
sitio con la misma aritmética de husos, que es cómo se acaba cortando el día de dos maneras
distintas dentro del mismo producto.

## La consulta — `metricas()` en `automations.service.ts`

Tres consultas en `Promise.all`, molde `KpisService.resumen`:

1. Los ids del tenant (`automation.findMany`, orden de `list()`). Aparte porque un flujo sin
   runs no aparece en ninguna de las otras dos y tiene que salir igual.
2. Los cubos, agregados en Postgres con `$queryRaw` + `Prisma.sql`. El resultado está
   acotado: flujos × días × estados, no una fila por ejecución.
3. La última ejecución **de siempre** (`automationRun.groupBy` con `_max: { createdAt }`), sin
   filtro de fecha: `null` tiene que querer decir «nunca», no «no esta semana».

El `AT TIME ZONE 'UTC'` de en medio en (2) **no sobra**:

```sql
(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE $tz)::date::text
```

`createdAt` es `TIMESTAMP(3)` **sin** zona y guarda UTC. Sin ese primer paso Postgres
interpreta el valor guardado como hora local del servidor, y el corte del día se va entero —
un fallo que en un servidor en UTC no se ve nunca y en cualquier otro descoloca el sparkline.

## La fuga que se tapó de paso

`sinToken()` existía desde que se vio que `hookToken` viajaba al navegador en cada listado,
pero solo se aplicaba en `list()` y `get()`. `create`, `patch`, `guardarGrafo` y `setStatus`
devolvían la fila cruda, así que el secreto de la URL pública del disparador acababa igual en
memoria del navegador, y sin `hookUrl`, que es lo único que la pantalla necesita. Ahora pasan
las seis por el mismo mapeo. El cambio de forma está en el contrato §Compatibilidad.

## Lo que NO se construyó (y por qué)

- **Índice por `createdAt`.** `AutomationRun` tiene `(tenantId, status)` y `(automationId)`;
  la ventana filtra después del índice de tenant. Marcado `ponytail:` en el código con su
  techo (un tenant con cientos de miles de ejecuciones) y su camino
  (`@@index([tenantId, createdAt])`). Añadirlo hoy es una migración por un problema que nadie
  tiene.
- **Caché de la zona del tenant.** Una lectura por PK por llamada, como `TasksService.zonaDe`,
  y por el mismo motivo: es la consulta más barata del camino y evita un estado que invalidar
  cuando alguien cambia su zona.
- **Rangos arbitrarios y desglose por hora.** No hay pantalla que los pida.

## Restricciones

- **`tenantId` sale del `@CurrentUser()`**, nunca de la query ni del body. En el SQL crudo va
  como parámetro (`$1`), no interpolado.
- **La zona entra en el SQL solo después de `zonaValida`.** Es el único valor de la consulta
  que viene de un campo de texto que rellena el usuario en el onboarding.
- **`armar` descarta las filas cuyo flujo no esté en `automationIds`**, no inventa entradas.
  Es el último filo del alcance en esta capa: la lista viene ya acotada por `tenantId`, así
  que descartar es lo que impide que un flujo ajeno se cuele si la consulta de arriba se
  escribe mal algún día.
- **La ruta va ANTES de `@Get('automations/:id')`** en el controlador. Detrás, `:id` se traga
  `metrics` y el servicio busca una automatización con ese id.
- **Un estado del enum que no se reconozca cuenta en `serie` y en ninguna otra parte, sin
  lanzar.** `AutomationRunStatus` puede crecer, y un valor nuevo no puede tumbar la pantalla.
- **`sinToken()` no es opcional**: un método nuevo que devuelva una `Automation` y no pase por
  él reabre la fuga de `hookToken`.

## Verificación

1. `npx ts-node src/automations/metricas.check.ts` → `metricas.check OK`.
2. `npm run build` — la ruta nueva compila y `metrics` no colisiona con `:id`.
3. `docker compose up -d && npm run start:dev`. Con sesión de un tenant con
   `automations:manage`:
   - `GET /automations/metrics` → `dias: 7`, `desde` con formato `YYYY-MM-DD`, y **una entrada
     por cada** automatización que devuelve `GET /automations`, incluida alguna sin
     ejecuciones (`serie` a ceros, `ultimaEjecucion: null`).
   - `POST /automations/:id/run` y volver a pedirlo: `serie.at(-1)` sube en 1 en el acto (el
     run nace `running`) y `ok` sube cuando termina. Mientras corre,
     `sum(serie) > ok + fallidas + cortadas`.
   - `?dias=1` → una sola posición; `?dias=99` → 30; `?dias=0` y `?dias=abc` → 7. Ningún 400.
   - `UPDATE "Tenant" SET timezone = 'Pacific/Kiritimati'` (UTC+14) y volver a pedirlo:
     `desde` se mueve un día respecto a UTC. Y con `timezone = 'Marte/Olympus'`: responde en
     UTC, no un 500. Esto es lo que el check no puede comprobar, porque necesita la base.
4. **La fuga**: `POST /automations`, `PATCH /automations/:id`, `PUT /automations/:id/graph`,
   `POST /automations/:id/activate` y `.../deactivate` — ninguna respuesta contiene
   `hookToken`, y todas traen `hookUrl`.
5. **Aislamiento entre dos tenants**: con la sesión de B, `GET /automations/metrics` no trae
   ningún `automationId` de A. Se dispara un run en A y se comprueba que ni la serie ni los
   contadores ni `ultimaEjecucion` de B se mueven.
6. `npm run check` — pasa entero.
