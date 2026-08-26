# 46-backend — Agenda de tareas

**Objetivo:** un scope que devuelva los cuatro cubos en una consulta acotada, dos campos más en
la fila de tarea, y una ruta para deshacer un cierre.
**Contrato:** `../GW/contrato/46-agenda-de-tareas.md` §Formas
**Depende de:** `crm/tasks.buckets.ts`, `crm/tasks.query.ts`, `crm/tasks.service.ts`.
**Definición de hecho:** `GET /tasks?scope=agenda` devuelve pendientes de cualquier fecha más
las cerradas de los últimos siete días del negocio, con las abiertas por delante; cada fila trae
`deal.amount` y `createdBy`; `POST /tasks/:id/reopen` reabre y `GET /tasks/resumen` trae
`cerradasHoy`; y `npm run check` pasa entero.

## Por qué así

El dato ya estaba todo en `Task`, y la relación `createdBy @relation("TaskCreator")` y la
columna `Deal.amount` también: **esta feature no lleva migración**. Lo que faltaba era un scope
que no obligara a elegir entre «todas las pendientes» y «las cerradas», y una ruta para el
único cambio de estado que no tenía forma de hacerse.

`todas` no servía. No filtra por `completedAt` y ordena `dueAt asc` con `take: 200`, así que en
un tenant con historia las 200 filas se las comen las cerradas más antiguas y la agenda de hoy
no cabe. Con la pantalla vieja no se veía porque tiraba las hechas; con los cuatro cubos sí.

Que el reparto en cubos lo haga el cliente, que la `Activity` del cierre sobreviva a reabrir,
que `outcome` se limpie y que `createdBy: null` signifique «lo hizo el sistema»: **eso es del
contrato, §Lo que NO cruza la frontera, y aquí no se vuelve a argumentar.**

> Se decidió **en contra** de resolver `agenda` con `NOT: { completedAt: { lt: X } }`, que
> evitaría el `OR`. En SQL `NULL < X` es *unknown* y `NOT unknown` sigue siendo *unknown*, así
> que las tareas abiertas —el grueso de la lista— se caerían de la consulta. Es correcto de leer
> y falso de ejecutar.

> Se decidió **en contra** de dejar el rango donde estaba, pegado sobre el `where` en el
> servicio. Con un `OR` en juego eso era la familia de bugs de `CLAUDE.md` esperando: un
> `where.OR = […]` pisa lo que hubiera. Y mientras la mitad de la consulta se armara fuera de
> `buildTaskWhere`, el check no podía afirmar sobre el `where` **final**, que es lo que la
> convención pide precisamente porque aquí es donde se pierde el aislamiento.

> Se decidió **en contra** de un índice nuevo. El `ORDER BY` de `agenda` es de dirección mixta,
> así que `(tenantId, assignedUserId, completedAt, dueAt)` sirve el filtro pero no el orden, y
> queda un nodo de ordenación. Sobre unos miles de filas por tenant no se nota, y una migración
> por un problema que nadie tiene es una migración de más.

## El scope — `crm/tasks.buckets.ts`

- `SCOPES` (`:69`) gana `'agenda'`. `parseScope` no cambia: sigue cayendo a `'hoy'`.
- `RangoScope` (`:79`) pasa a ser una interfaz con nombre —antes era un tipo inline— y gana
  `cerradasDesde?: Date`. Con nombre porque ahora la consume `tasks.query.ts`.
- `case 'agenda'` (`:119`) no acota `dueAt` (si lo acotara faltaría uno de los cubos) y devuelve
  `completadas: null` más el corte de las cerradas.
- `haceSieteDias(inicioDeHoy, tz)` (`:138`) retrocede **re-anclando**, no restando `7 × 24 h`:
  el día del cambio de horario de verano dura 23 o 25 horas, así que una semana fija desvía el
  corte una hora y deja de ser una medianoche. Se retrocede a media mañana del día −7 —que cae
  dentro de ese día con cualquier transición— y se le vuelve a pedir su medianoche. Es el mismo
  truco que el `+36 h` de `rangoDeScope` (`:100-107`) hacia delante, y que `ventana()` en
  `automations/metricas.ts`.

**El gemelo del frontend no se toca, y está comprobado.** Lo duplicado con
`frontend/src/app/tareas/tareas.buckets.ts` es el **clasificador** (`bucket`, `diaEn`);
`SCOPES`, `parseScope`, `rangoDeScope`, `inicioDelDia` y `componerDueAt` solo existen de este
lado, porque el frontend reordena una lista que ya le llega repartida. Añadir un scope no obliga
a tocar el otro archivo. Queda escrito en la cabecera de `tasks.buckets.check.ts` para que no
haya que volver a comprobarlo.

## El where — `crm/tasks.query.ts`

`buildTaskWhere` (`:133`) recibe el `rango` y lo **suma** al mismo `AND` que los filtros de
pantalla. Los tres casos:

- `desde`/`hasta` → `{ dueAt: { gte, lt } }`, cada extremo solo si lo hay.
- `completadas` `true`/`false` → `{ completedAt: { not: null } }` / `{ completedAt: null }`.
  `null` no suma nada, que no es lo mismo que `false`.
- `cerradasDesde` → `{ OR: [{ completedAt: null }, { completedAt: { gte } }] }` (`:156-160`).

El `OR` va **dentro** del `AND`, nunca en la raíz. Hoy nada más pone un `OR` en este `where`,
pero asignarlo en la raíz es exactamente cómo `buildDealWhere` abrió su agujero, y el alcance de
tareas ya lo abrió una vez por la otra vía.

Con esto `TasksService.list` deja de componer media consulta a mano y el check pasa a ver lo que
Postgres va a recibir.

## El servicio — `crm/tasks.service.ts`

- **`TASK_INCLUDE` (`:22`)** gana `createdBy: USER_SELECT` —la misma forma que `assignedUser`,
  reutilizando la constante que ya existía— y `amount` en el `select` del trato. Cambia la forma
  de todas las respuestas de tarea a la vez, que es lo que se quiere: una sola forma salga del
  método que salga.
- **`list` (`:47`)** pasa el `rango` a `buildTaskWhere` y estrena el orden de `agenda`:
  `[{ completedAt: { sort: 'desc', nulls: 'first' } }, { dueAt: 'asc' }]`. **El orden es la
  mitad de la corrección**, no un detalle: con `dueAt asc` a secas, una tarea cerrada hace tres
  días vence hace tres días y se cuela delante de las de hoy, así que el tope de 200 se lo
  vuelve a comer el pasado — el bug que este scope existe para no tener. Abiertas primero y
  cerradas detrás significa que el recorte cae sobre las cerradas más viejas. `nulls` va
  explícito y no por el implícito de Postgres para `DESC`: es un default de motor.
- **`resumen` (`:91`)** gana un tercer `count` en el `Promise.all` que ya estaba, con el mismo
  alcance que los otros dos. Sin cota superior, porque una tarea no se cierra en el futuro.
- **`reopen` (`:272`)** es espejo de `complete`: mismo `buscar()` —o sea mismo `taskScope` y
  mismo 404 para la tarea de otro—, guarda invertida, y `task:updated` más `deal:updated` si
  cuelga de un trato, porque reabrir **apaga** el punto de huérfano de la tarjeta. Sin
  transacción: es un solo `update` y no hay `Activity` que escribir, que es la decisión del
  contrato.

`reopen` no devuelve `dejaTratoHuerfano`. Es la operación contraria a `complete` y no puede
dejar un trato sin próxima acción, así que el campo sería siempre `false` — un campo «por si
acaso» con forma de dato.

## Lo que NO se construyó (y por qué)

- **Paginación de `agenda`.** El `ponytail:` de `TASKS_TAKE` (`tasks.query.ts:5-6`) sigue en pie
  con su camino: filtrar por tipo o por rango, no paginar. Lo que cambia es que ahora el recorte
  tira lo que menos importa en vez de lo que más.
- **Ventana de cerradas configurable.** Siete días es lo que pide la pantalla. Un `?dias=` sin
  nada que lo mueva es un parámetro «por si acaso», y además obligaría a acotarlo y a
  documentarlo.
- **El conmutador «Mías / Del equipo» para un admin, y `equipo` en `/tasks/resumen`.** Son la
  misma decisión mirada desde dos sitios, y se arreglan juntas o no se arregla ninguna.

  `taskScope` (`deal-scope.ts:35-38`) devuelve `{}` para un admin, y `alcance()`
  (`tasks.service.ts`) lo usa **también** como filtro por defecto: con `equipo=false` un admin
  recibe `{}`, o sea las tareas de todo el negocio. Para él las dos posiciones del conmutador
  devuelven exactamente lo mismo. Al revés, `resumen()` no mira `equipo` nunca, así que el
  contador del menú y la lista de un jefe cuentan con alcances distintos.

  El diagnóstico —de la sesión de frontend, que lo vio en pantalla porque las filas ahora pintan
  las iniciales del responsable— es que **`taskScope` es correcto como autorización y no como
  filtro**: decide qué filas se PUEDEN ver, no cuáles se han PEDIDO. «Mías» significa «asignadas
  a mí» también para el jefe. Es la misma confusión que `CLAUDE.md` señala con «la etiqueta no
  es la cartera»: un concepto que autoriza haciendo además de descriptor.

  **No se toca aquí, y no es una regresión de la 46**: viene de la 37, cambia lo que
  `GET /tasks` devuelve hoy a todos los admins —o sea rompe—, y por lo tanto es una feature
  numerada aparte con su contrato, no un arreglo de paso. Lo que sí se hizo fue **no ampliar el
  problema**: `cerradasHoy` cuenta con el mismo alcance que los otros dos contadores en vez de
  estrenar una tercera regla.

  El camino, cuando se haga: en `alcance()`, con `equipo=false` devolver
  `{ assignedUserId: userId }` sea cual sea el rol, y dejar `taskScope` solo donde autoriza
  —`buscar()`, que es quien tiene que seguir dejando a un admin cerrar la tarea de otro—. Con
  `equipo=true` sigue mandando `deals:manage`, que ya se resuelve bien.
- **`ActivityType.task_reopened`** y el borrado de la `Activity` del cierre. Argumento entero en
  el contrato §Lo que NO cruza la frontera, punto 2.
- **Que `PATCH` conserve la hora cuando llega `dueDate` sin `dueTime`.** Hoy `parseVencimiento`
  recompone a las 09:00 del día del negocio, así que aplazar una tarea de las 16:15 le cambia
  también la hora. Se queda como está por dos motivos: el único cliente que hace `PATCH` es la
  app, y ya manda `dueTime` calculado en la zona del tenant (lo comprobó la sesión de frontend);
  y conservarla obligaría a pasarle a `parseVencimiento` el `dueAt` actual, o sea a dejar de ser
  una función pura del cuerpo — que es lo que hace que su check no necesite base.
  `ponytail:` el techo es un segundo cliente que haga `PATCH` sin `dueTime` (el asistente, un
  flujo) y le mueva la hora a alguien sin decirlo; el camino es la firma
  `parseVencimiento(src, timezone, actual?)`.

## Restricciones

- **El rango se SUMA al `AND`, nunca se asigna sobre el `where`.** Vale para `dueAt`, para
  `completedAt` y sobre todo para el `OR` de `agenda`: en la raíz, un `OR` pisa cualquier otro
  que llegue por el alcance el día que llegue. El check lo afirma sobre el `where` **final** y
  recorriendo combinaciones, no sobre las piezas por separado.
- **`agenda` no acota `dueAt`.** Si algún día se le pone un suelo por rendimiento, deja de
  contener el cubo de Atrasadas y la pantalla miente sin fallar.
- **El orden de `agenda` es parte de la respuesta**, no una preferencia. Cambiarlo a `dueAt asc`
  reabre el bug del tope.
- **`reopen` pasa por `buscar()`**, como todo `/tasks/:id`. Un `prisma.task.update` directo por
  id saltaría `taskScope` y dejaría reabrir la tarea de cualquiera, incluida la de otro tenant.
- **`createdById` sigue siendo nulable y `createdBy` puede ser `null`.** No es un dato que
  falte: es cómo se dice que la creó el sistema. Un `User` ficticio «Sistema» contaminaría
  `GET /users` y la asignación de conversaciones — el mismo argumento con el que la 33 no crea
  usuarios pendientes.
- **La `Activity{task_done}` no se borra nunca.** No hay un solo `activity.delete` en `src/`, y
  `Activity.taskId` es `onDelete: SetNull` precisamente para que el registro sobreviva a su
  tarea. Un borrado aquí rompe el timeline y mueve KPIs hacia atrás.
- **`haceSieteDias` no se sustituye por `- 7 * 24 h`.** Dejaría de devolver una medianoche los
  días de transición, y una ventana que no empieza a medianoche no es comparable entre dos
  semanas del año.

## Verificación

1. `npx ts-node src/crm/tasks.buckets.check.ts` → `crm/tasks.buckets.check OK`.
   `npx ts-node src/crm/tasks.query.check.ts` → `crm/tasks.query.check OK`.
2. `npm run build` — compila, y `reopen` no colisiona con `:id`.
3. `docker compose up -d && npm run start:dev`, y los datos de prueba:

   ```
   docker exec -i whatsops-backend-postgres-1 psql -U whatsops -d whatsops      -f - < prisma/sql/seed-46-agenda.sql
   ```

   `prisma/sql/seed-46-agenda.sql` es idempotente y **no lleva ni una fecha literal**: las
   deriva de `now()` en la zona del tenant, así que corrido dentro de un mes sigue
   significando lo mismo. Siembra los cuatro cubos, los dos extremos de la ventana de siete
   días (cerradas hace 6 y hace 9), una tarea sin trato, una sin contacto, una con
   `createdById` nulo, y un segundo usuario `agent` —`qa.agente@cma.test`— para el
   conmutador «Del equipo» y para poder probar el alcance con una cuenta que no es admin.
   Todo lleva el prefijo `seed46-`, y la última consulta del archivo lo retira entero.

   Con sesión de un tenant con `tasks:write`:
   - `GET /tasks?scope=agenda` → trae atrasadas, de hoy, próximas y cerradas en la misma
     respuesta. **Todas las abiertas salen antes que cualquier cerrada**, y ninguna cerrada tiene
     `completedAt` anterior a la medianoche del día de hace siete.
   - Cerrar una y volver a pedirlo: sigue en la lista, ahora al final. Con `scope=hoy`
     desaparece, como siempre.
   - Cada fila trae `deal: { id, title, amount }` con `amount` **string** (o `null`) y
     `createdBy`. Una tarea nacida de un cambio de etapa (`deals.service.ts`, `auto-task.ts`)
     trae `createdBy: null`, no un objeto vacío.
   - `POST /tasks/:id/reopen` sobre una cerrada → 200, `completedAt: null`, `outcome: null`.
     Repetir → `400 'Esa tarea no estaba completada'`. Sobre una que nunca se cerró → el mismo
     400.
   - **El timeline del contacto sigue enseñando la entrada del cierre con su texto** después de
     reabrir (`GET /contacts/:id/timeline`). Es la decisión del contrato, y esto es lo que la
     comprueba.
   - Reabrir la única tarea de un trato → llega `deal:updated` a una segunda pestaña y el punto
     de huérfano de la tarjeta se apaga.
   - `GET /tasks/resumen` → `cerradasHoy` sube en 1 al cerrar una y **baja en 1 al reabrirla**.
4. **La zona, que es lo que el check no puede comprobar** porque necesita base:
   `UPDATE "Tenant" SET timezone = 'Pacific/Kiritimati'` (UTC+14) y volver a pedir
   `scope=agenda` → el corte de las cerradas se mueve un día respecto a UTC, y `cerradasHoy` se
   recalcula sobre el día del negocio. Con `timezone = 'Marte/Olympus'` responde en UTC, no un
   500.
5. **El alcance, con dos usuarios del mismo tenant:** un `agent` pide
   `GET /tasks?scope=agenda&assignedUserId=<el otro>` → lista **vacía**, no la agenda ajena (el
   filtro convive con el alcance, no lo sustituye). Y `POST /tasks/<id del otro>/reopen` → 404.
6. **Aislamiento entre dos tenants:** con la sesión de B, `scope=agenda` no trae ninguna tarea
   de A; `POST /tasks/<id de A>/reopen` → 404 **y la tarea de A sigue cerrada**; se cierra una
   tarea en A y el `cerradasHoy` de B no se mueve.
7. `npm run check` — pasa entero (56/56).
