# 42-backend — Simulación en seco

**Objetivo:** recorrer el grafo de una automatización con una entrada inventada y devolver qué
haría —incluido el texto exacto que mandaría— sin que salga nada hacia ningún cliente.
**Contrato:** `../GW/contrato/42-simulacion-en-seco.md` §Formas
**Depende de:** `automations/catalog.ts` (`Servicios`), `automations/graph.ts`,
`automations/contexto.ts`, `automations/automations.processor.ts` (la costura, no el código).
**Definición de hecho:** `POST /automations/:id/simular` responde con los pasos, sus efectos y
sus variables para una automatización **en borrador**, y tras varias simulaciones seguidas no
hay ni una fila nueva en `Message`, `Conversation`, `Deal`, `Task`, `Activity`,
`AutomationRun` ni `AutomationRunStep` —contadas antes y después—, y `npm run check` pasa
entero (57).

## Por qué así

`runManual` (`automations.service.ts:395`) decía en su propio comentario que servía «para
probar cualquier automatización sin esperar a que escriba un cliente». Pero crea un run de
verdad: el `message.send` sale, el trato se crea, la tarea se asigna. **Probar un flujo costaba
mensajes reales a personas reales**, y encima exigía `status === 'active'`, o sea que había que
activar para probar. «Configúralo bien y pruébalo» era una instrucción que el producto no
permitía cumplir.

## La costura es `Servicios`, y es un solo punto de sustitución

El motor ya tenía el sitio exacto por donde cortar. `automations.processor.ts` arma
`{ messaging, conversations, deals, tasks }` y se lo pasa al handler; el catálogo **solo conoce
el tipo estructural** (`Servicios`, `catalog.ts:60`), nunca la clase real. Es decir: el catálogo
ya estaba escrito contra una interfaz sin saberlo.

En seco se le pasa un doble que registra la llamada con sus argumentos **ya interpolados** y
devuelve una forma plausible. **Los 23 handlers no se tocan**: ninguno aprende que existe un
modo simulación.

> Se decidió **en contra** de un flag `dryRun` hilado por los handlers. Es lo obvio y es
> exactamente el fallo que `interpolarConfig` ya corrigió una vez en este mismo módulo: cuando
> interpolar era decisión de cada handler, once campos se la saltaban en silencio. Aquí las
> consecuencias son peores — el handler que se lo saltara **mandaría un mensaje real desde una
> simulación**. Si un tipo de nodo consigue provocar un efecto externo en seco, esto está mal
> construido, no incompleto.

Las formas que devuelven los dobles no son adorno: `message.send` lee `msg?.wamid`,
`conversation.addNote` lee `nota?.id` y `deal.create` lee `deal?.title`. Un doble que devolviera
`undefined` dejaría `{{vars.<nombre>.title}}` a null en seco y con valor en producción — justo
la clase de diferencia que hace inútil una simulación.

## El recorrido — `automations/simulacion.ts`

Puro salvo por los handlers que llama: no toca Prisma, ni la cola, ni la red. Lo que necesita de
la base se lo da hecho el servicio en `EntradaSimulacion`.

Usa **las mismas funciones que el worker** para todo lo que decide el camino: `nodoRaiz`,
`siguienteNodoId`, `interpolarConfig` y `conSalidaYVariable`. Si la simulación eligiera las
ramas por su cuenta, enseñaría un camino que no es el que va a ocurrir, y entonces no sirve
para nada.

`conSalidaYVariable` **salió del processor a `contexto.ts`** en esta feature. Era un método
privado de tres líneas, pero desde ahora hay dos recorridos del grafo y esa es la regla que no
puede divergir: si la simulación nombrara las variables de otra forma, el «Contexto final» que
enseña sería otro que el de producción.

> *ponytail: el esqueleto del bucle sí queda duplicado con `avanzar`. Techo: si los dos
> divergen, la simulación miente. Camino: lo que no puede divergir —el enrutado y el nombrado
> de variables— ya está fuera de los dos, en `graph.ts` y `contexto.ts`; lo que queda en cada
> uno es la persistencia, que en seco no existe.*

**Es síncrona, y eso NO viola «el webhook nunca procesa inline».** Ese principio protege el
camino del webhook: firma → encolar → 200. Esto es una acción de admin sobre un DAG validado,
acotada por `TOPE_PASOS` y con un `Set` de nodos vistos haciendo a mano lo que en producción
hace la unique `(runId, nodeId)`. Termina siempre.

## Lo que la costura no cubre, y por qué se trata aparte

- **`http.request` no pasa por `Servicios`**: llama a `fetch` él mismo (`catalog.ts:494`). Se
  intercepta en el recorrido, antes del handler. Con el interruptor apagado —el defecto— usa la
  respuesta que escribió el operador; sin ninguna escrita, para y la pide.
- **`code.run` se ejecuta de verdad**, con su mismo tope de 1 s y 16 KB. Es cómputo puro en un
  proceso hijo sin red: ver qué calcula **es** el objetivo, y un doble que devolviera algo
  plausible convertiría el nodo más difícil de configurar en el único que no se puede probar.
- **Las esperas no se esperan: se enseñan.** `wait.delay` reporta y sigue —un flujo con una
  espera de 30 días termina la simulación en vez de colgarla— y `wait.reply` para.

## Qué entra según el disparador — `entradaSegunTrigger`

El contrato dice que un campo que no case con el disparador se ignora. **Ignorar de verdad hay
que hacerlo**: la primera versión miraba `texto` antes que el tipo, así que un `texto` colado en
una automatización de `schedule.cron` armaba un contexto de **mensaje**, y la simulación probaba
un disparo que no es el que va a ocurrir. Nadie devuelve un error, así que el operador se cree
la prueba. Lo encontró el check del frontend afirmando «qué no viaja»; aquí se afirma «qué no
entra», con una función pura y su tabla en el contrato.

Al lado había otro peor: el tipo del disparador se leía como `a.trigger.tipo`, y la clave real es
**`type`** (`validarTrigger`, `catalog.ts:753`). Caía siempre al `'manual'`, o sea que simular
una automatización de palabra clave decía en `disparador.tipo` que la había disparado otra cosa.
No rompía nada y no daba ningún error: contestaba con seguridad sobre un disparo que no era.
**`disparador.tipo` es siempre el de la automatización**, nunca uno deducido de lo que mande el
cliente.

## `variables`: vacía e inalcanzable son dos avisos

En pantalla `Hola ` y `Hola` son indistinguibles. Sin esto, el operador no puede saber si ahí
había una variable que se resolvió a nada — que es la mitad del valor de la feature.

Y son **dos** problemas, no uno:

- `vacia` — la ruta es válida y no hay valor. Se arregla rellenando el dato.
- `inalcanzable` — no parsea, así que sale **literal con las llaves** (`{{vars.mi campo}}`, con
  espacio). Está mal escrito y no va a resolver por mucho que se rellene.

Lo llena **`interpolar` misma mientras sustituye**, con un colector opcional que
`interpolarConfig` hila. No un recorrido aparte: calculado por su cuenta, el aviso acabaría
hablando de una sustitución distinta de la que ocurre — y de paso, por ir por `interpolarConfig`,
respeta `sinInterpolar` sin saber qué campos son.

> La `spec/v11/42` dice que `Hola {{vars.mi campo}}` sale como `Hola `. Es **incorrecto**: sale
> literal. Corregido en el contrato §Verificación y fijado en `simulacion.check.ts`.

## `bloqueado` significa una sola cosa

«En producción esto no habría ido como parece»: un envío que la ventana de 24 h habría frenado,
o un run que se habría cortado. Dos productores, y ninguno más.

**Se construyó al revés y se corrigió.** La primera versión lo usaba también para «no se llamó
a la API» y «esperando que escribas la respuesta», que son el funcionamiento **normal** de una
simulación. Con eso, tres de cada cuatro rojos eran normales, y entonces el cuarto —el único que
existe para que la simulación no mienta por optimista— deja de leerse. Esos dos casos van en
`resumen`, y que la simulación esté parada ya lo dice `pendiente`.

El freno de la ventana se evalúa **una vez**, fuera del recorrido: es una propiedad de la
conversación —cuándo escribió el cliente por última vez— y solo se reabre con un entrante, no
con nada que haga el grafo. Mismo predicado (`isWithinWindow`) y mismo texto
(`adapter.windowClosedMessage`) que `messaging.service.ts:122`, para que la simulación no
invente un freno distinto del que va a aplicarse. Y cuelga de **`adapter.enforcesWindow`**,
nunca del nombre del canal: WAHA no tiene ventana de 24 h y ahí lo correcto es que no aparezca.

## Sin sesión: se rejuega desde cero

No hay fila `AutomationRun` —una simulación no puede tomar el candado de una conversación real,
ni llenar el historial de runs falsos que luego se confundan con producción—, así que **no hay
nada que reanudar**. Cuando el recorrido llega a un `wait.reply` o a un `http.request`, la
respuesta trae `pendiente` y el cliente vuelve a llamar con la lista entera de `respuestas` y
`httpRespuestas`. Sin id de simulación, sin TTL, sin limpieza y sin mensaje de caducidad que
pintar. Con el tope de 1 s de `code.run`, rejugar sale más barato que mantener el estado.

`null` dentro de `respuestas` significa **«no contestó»** y encamina por la rama de caducidad.
No una cadena centinela: una centinela es texto que un cliente puede teclear, y el día que
alguien conteste literalmente eso el flujo se iría por la rama equivocada. La rama se busca por
**estructura y no por nombre**, igual que `sinRespuesta` en el motor: `wait.reply` ofrece
«contestó» (rama `null`) y la de caducidad, así que la de caducidad es la única con nombre.
Comparar contra un literal es lo que ya dejó una arista muerta en silencio una vez.

## Lo que se escribió de paso

Al montar la pantalla, el frontend encontró que su lista de «conversaciones esperando» es
correcta **por una invariante de esta capa que no estaba escrita**: ordena por `lastInboundAt`
tratando el null como el valor más antiguo, y no falla porque filtra antes por `unread > 0`, que
cuenta `direction = 'in'`, y todo entrante deja `lastInboundAt` puesto. Está escrito ahora encima
del conteo de no leídos de `conversations.service.ts` —el `$queryRaw` con
`m.direction = 'in'`—, que es el sitio donde se rompería.
No lleva guardia: envolver un caso que el filtro impide es código que después nadie puede borrar
porque nadie sabe por qué está.

## Lo que NO se construyó (y por qué)

- **Historial de simulaciones.** Marcado `ponytail:` con su techo: una columna
  `simulado Boolean` en `AutomationRun` el día que haga falta guardarlas. Hoy los pasos van en
  la respuesta y ya está.
- **`respuestasSinUsar`.** Si el operador reedita el grafo a mitad de una tanda y sobran
  respuestas, se ignoran en silencio. No se devuelve el recuento porque **el residuo no cambia
  lo que se ve**: la traza enseña dónde paró de verdad, así que no hay una pantalla optimista
  que corregir. Nombre acordado con el frontend por si algún día entra.
- **Simular la rama «no contestó» sin pedirla.** No se deduce: hace falta el `null` explícito.
- **`@@index([tenantId, createdAt])` en `AutomationRun`.** Sigue pendiente de la 45 y entra con
  la 43, que es la que multiplica las filas.

## Restricciones

- **Nada de la simulación escribe** en `AutomationRun`, `AutomationRunStep`, `Message`,
  `Conversation`, `Deal`, `Task` ni `Activity`. La prueba de aceptación es **contar filas y
  llamadas**, no leer código.
- **Un solo punto de sustitución.** Un tipo de nodo que consiga un efecto externo en seco es un
  fallo de construcción. `simulacion.check.ts` rompe `fetch` para todo el archivo y no lo repone.
- **No toma el candado de ninguna conversación**, y por eso un mensaje real de esa misma
  conversación dispara con normalidad mientras se simula.
- **No consume cupo ni ritmo**: no pasa por `checkLimits` ni por `lifecycle.ts`, porque no manda
  nada. Pero **sí enseña** cuándo un envío real se habría frenado.
- **Alcance por `tenantId`** en la automatización, en el `messageId` que se repite y en la
  conversación — en el `where`, nunca en un `if` posterior.
- **Funciona en borrador.** Tampoco valida el grafo con `problemasDelGrafo`: a medio dibujar
  está roto por definición, y probar el trozo que ya existe es para lo que se simula.
- **Un id de conversación falso** (`'conversacion-simulada'`) cuando no hay ninguna: nada toca la
  base, así que el único efecto es que los nodos que la necesitan se puedan probar igual en vez
  de reventar.

## Verificación

1. `npx ts-node src/automations/simulacion.check.ts` → `simulacion.check.ts OK`.
2. `npm run check` → 60/60. `npm run build` limpio.
3. Con la base levantada, cargar el grafo de prueba:

   ```bash
   docker compose up -d postgres redis
   docker exec -i whatsops-backend-postgres-1 psql -U whatsops -d whatsops \
     -f - < prisma/sql/seed-42-simulacion.sql
   ```

   Deja **dos** automatizaciones en borrador. `seed42-auto` toca todo: envío con las tres
   clases de variable, `deal.create`, `code.run`, espera de 30 días, `wait.reply` con sus dos
   ramas y `http.request`. Y `seed42-sinrama` existe solo para ver el **segundo** productor de
   `bloqueado`: un `wait.reply` **sin** rama de caducidad, que con la primera no se puede
   provocar porque siempre encuentra a dónde seguir. Se retiran con
   `DELETE FROM "Automation" WHERE id IN ('seed42-auto', 'seed42-sinrama')`.

4. **Contar antes**, simular varias veces y **contar después**. Tienen que ser idénticos:

   ```sql
   SELECT (SELECT count(*) FROM "Message")            AS msgs,
          (SELECT count(*) FROM "Deal")               AS deals,
          (SELECT count(*) FROM "Task")               AS tasks,
          (SELECT count(*) FROM "AutomationRun")      AS runs,
          (SELECT count(*) FROM "AutomationRunStep")  AS pasos,
          (SELECT count(*) FROM "Activity")           AS acts;
   ```

5. Con sesión de un tenant con `automations:manage`, sobre `seed42-auto`:
   - `{ texto: 'hola', conversationId: '<la del seed>' }` → `status: 'waiting'`,
     `pendiente: { nodeId: 'seed42-n5', tipo: 'wait.reply' }`. El paso del envío trae
     `Hola <nombre>, total  y {{vars.mi campo}}` y las tres `variables` con `ok`, `vacia` e
     `inalcanzable`. El de `code.run` trae `{ respuesta: 42 }` — calculado de verdad.
   - Añadiendo `respuestas: ['sí quiero']` → para en `seed42-n6` con
     `tipo: 'http.request'`, y **no llamó a nadie**.
   - Añadiendo `httpRespuestas: { 'seed42-n6': { saldo: 1234 } }` → `status: 'done'` y el último
     envío dice `Dijiste sí quiero. Tu saldo es 1234 y el cálculo dio 42.`
   - Con `respuestas: [null]` → sigue por `seed42-n8`, la rama «no contestó», y **no** pasa por
     el `http.request`.
   - `disparador.tipo` del contexto es `message.inbound`, el de la automatización.
   - Sobre `seed42-sinrama` con `respuestas: [null]` → `status: 'done'`, tres pasos, y el del
     `wait.reply` llega con `bloqueado: 'El run real se cortaría aquí: no hay a dónde seguir.'`
     Es el único camino por el que se ve ese segundo productor.
6. **Aislamiento**: con el `tenantId` de otro tenant, `simular` sobre `seed42-auto` responde 404.
7. **La ventana de 24 h**: solo se puede ver el caso positivo con una conversación de **Cloud
   API**. Con las conexiones WAHA de la base de desarrollo, `enforcesWindow` es `false` y lo
   correcto es que `bloqueado` **no** aparezca — no es un fallo.
8. **`wait.delay` de 30 días reporta 10080 min, no 43200.** No es un error: el catálogo topa la
   espera en 7 días (`TOPE_ESPERA_MIN`), y en seco se ve el valor **topado**, que es el que va a
   ocurrir.

### Firmado contra base el 2026-08-26 — los puntos 3 a 8, 8 de 8

Los contadores del punto 4 salieron **idénticos** antes y después de seis simulaciones:
`1709 | 1 | 13 | 8 | 22 | 7` (msgs, deals, tasks, runs, pasos, acts). Es la única prueba que vale
para «no salió nada»; que el `status` diga `simulado: true` no prueba nada por sí solo.

Los cinco casos del punto 5 salieron con las frases citadas arriba, textuales, incluido el
`bloqueado` de `seed42-sinrama` — que viaja en el **efecto** del paso, no en el paso. El
`wait.delay` llegó con `input: {minutos: 43200}` y `output: {minutos: 10080}`, que es el punto 8
visible en la misma respuesta.

El punto 7 se comprobó y **no** apareció `bloqueado`, que es lo correcto: la única conexión del
tenant es WAHA (`enforcesWindow: false`). No es un fallo y no se apunta como pendiente.

El punto 6 se firmó con un tenant registrado a propósito (`QA Aislamiento`): `simular`, `sondear`,
`run`, `deactivate`, `GET /automations/:id` y `llamables` sobre ids de CMA → **404 los ocho**.
   ocurrir.
