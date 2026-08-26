# 43-backend — Ejecutar flujo (composición y sub-runs)

**Objetivo:** que una automatización pueda **llamar** a otra del mismo negocio, esperar su
resultado y usarlo, para que los flujos se combinen en vez de competir.
**Contrato:** `../GW/contrato/43-ejecutar-flujo.md` §Formas
**Depende de:** 41 (el candado), 42 (el contexto de prueba y el recorrido en seco).
**Definición de hecho:** un nodo `automation.run` ejecuta otra automatización dentro del paso
del padre, deja su `vars` en `{{vars.<nombre>}}`, escribe su propia fila `AutomationRun` con
`parentRunId`, y un reintento del padre **reanuda** al hijo en vez de rearrancarlo. Los cuatro
topes y las dos guardas de recursión se afirman sin base, y `npm run check` pasa entero (60).

## Por qué inline, y no encolando al hijo

Es lo primero que uno intenta y **las tres puertas están cerradas**:

- `Salida.esperar` solo tiene dos modos (`{ms}` y `{entrada, caducaMs}`), y no hay despertador
  para un tercero: `avanzar` solo reanuda un `waiting` con `reanudarEn`, y `trigger-on-inbound`
  solo con `waitingConversationId`.
- Un `waiting` sin ninguno de los dos es **invisible para el barrido** (`queHacerCon` devuelve
  `'nada'`): se queda colgado para siempre.
- Un padre que se quedara `running` esperando sería revivido a los 10 min por silencio, y como
  el paso se graba `ok` **después** del handler, el revivido **volvería a lanzar al hijo**. O
  sea, los mensajes del hijo dos veces.

> Ejecutar el hijo inline contradice la frase con la que abre el motor: «un nodo por job, no el
> grafo entero en un job, así el reintento reintenta el paso que falló y no todo lo anterior —que
> ya le mandó mensajes a un cliente». **Y se paga**, no se ignora: el hijo escribe sus pasos
> conforme avanza y un reintento del padre lo **reanuda**. Con la unique
> `(parentRunId, parentNodeId)`, el hijo recupera exactamente la misma idempotencia que el motor,
> con el mismo mecanismo y sin conceptos nuevos.

## La costura es `Servicios`, y esta vez el compilador la defiende

`Servicios` (`catalog.ts`) gana `flujos.ejecutar(...)`. El handler de `automation.run` queda de
tres líneas como los otros 23 y el motor no aprende que existen sub-flujos.

Lo que no se ve a simple vista: **añadir una clave a `Servicios` rompe la compilación de
`dobles()`** hasta que se le dé contraparte. La propiedad que `simulacion.check.ts` protege
—ningún tipo de nodo consigue un efecto externo en seco— se extendió a las llamadas **sin
escribir un check nuevo**. El precedente contrario ya duele: `http.request` no pasa por
`Servicios`, y por eso hay que interceptarlo a mano en el recorrido en seco.

## `subflujo.ts` — el recorrido, y por qué es un bucle propio

De `avanzar` el hijo no usa nada: ni cargar el run, ni reanudar, ni aparcar, ni
`continuar`+`cola.add`. Lo que sí comparten —el enrutado y el nombrado de variables— **ya estaba
fuera de los dos**, en `graph.ts` y `contexto.ts`. Extraer un «ejecutor de un nodo» común pedía
parametrizar cuatro comportamientos para reutilizar ocho líneas de `upsert`.

Y hay un argumento que decide: **`avanzar` no tiene check**. Es el código que decide qué se le
manda a un cliente y solo se puede probar a mano con Postgres y Redis levantados. Refactorizarlo
era el peor sitio del módulo donde meter un refactor. `subflujo.ts` sí tiene check, y es donde
viven las afirmaciones que antes no existían.

> *ponytail: el atajo del trigger («no se ejecuta, pero sí tiene salida») queda en tres copias de
> cuatro líneas. Techo: si esa regla cambia, hay tres sitios. Camino: una función en `catalog.ts`
> el día que sean cuatro.*

## `variableDe`: el paso y la variable dejan de ser lo mismo

El **paso** guarda `{runId, automationId, nombre, status}` —es lo que permite entrar al run del
hijo desde el cajón— y la **variable** trae el `vars` del hijo a secas. Con el sobre, el dato
quedaría en `{{vars.x.vars.total}}`, y el aplanado del editor topa la profundidad en 3: todo lo
anidado dentro **desaparecería del autocompletado**. Ese dato lo midió el frontend, y es lo que
decidió la forma.

Vive en `NodeType.variableDe` y **no en `Salida`**, y esa parte la encontré escribiendo el
camino de reintento: cuando un paso ya salió `ok`, el motor reutiliza su `output` guardado y
**no vuelve a llamar al handler**. Una decisión que viviera en la salida se perdería justo ahí,
y la variable acabaría con el sobre dentro **solo en los reintentos** — que es el peor sitio
posible para tener una diferencia.

## Las dos guardas de recursión

- **Al activar** — `llamadas.ts`, puro, con su check. `setStatus` carga el grafo de llamadas del
  tenant (alcance en el `where`) y suma sus problemas a los que ya componía. **No se extendió
  `problemasDelGrafo`**, que es donde la spec de producto lo puso: esa función es pura sobre un
  grafo y ni conoce su propio id; meterle la base dentro la convertiría en lo contrario de lo
  que es.
- **En ejecución** — `problemaAntesDeLlamar`, antes de tocar la base, para que un rechazo no deje
  ni una fila ni un efecto.

Las dos, porque la de activación **se queda vieja**: dos admins activando a la vez ven cada uno
un mundo sin el otro. Y porque un grafo de llamadas legal no es un grafo sano — A llamando a cien
flujos distintos es perfectamente acíclico.

## Los cuatro topes, y el que no se ve

`MAX_PROFUNDIDAD 3`, `TOPE_SUBRUNS 10`, `TOPE_NODOS 200`, todos sobre un presupuesto **compartido
por el árbol** (por padre se multiplicarían por nivel).

Y **`TOPE_TIEMPO_MS 60_000`**, que es el importante y el que no se ve: `SIN_SENAL_MS` son 10 min
contra el `updatedAt` del **padre**, y el árbol inline no lo toca. Pasados esos 10 minutos el
barrido revive al padre mientras el job original sigue vivo: el revivido encuentra al hijo por la
unique, lo reanuda, y hay **dos workers dentro del mismo hijo** — dos `message.send` del mismo
nodo, porque `registrarPaso` es un `upsert` y no choca.

La guarda que sostiene todo lo anterior: **un hijo nunca se revive suelto**. `RunParaBarrer` gana
`esHijo` y `queHacerCon` devuelve `'cortar'`. Sin eso, un hijo revivido por su cuenta saldría del
árbol —profundidad cero, sin presupuesto, sin cadena— y la guarda de recursión se evaporaría.

## El bug del historial, arreglado aquí

`AutomationRunStep.nodeId` tenía FK a `AutomationNode` con `onDelete: Cascade`, y `guardarGrafo`
hace `deleteMany` de **todos** los nodos en cada guardado. O sea que **guardar el grafo borraba
en silencio los pasos de todas las ejecuciones anteriores**, sin dar ningún error: el historial
viejo simplemente aparecía vacío.

Se retira la FK. El precio, declarado en el contrato: un paso puede apuntar a un nodo que ya no
está, y la pantalla tiene que decirlo en vez de dejar el título en blanco.

## Restricciones

- **`automationId` es `sinInterpolar`.** Si admitiera `{{...}}`, el texto que escribe un cliente
  elegiría qué flujo se ejecuta. No se cierra validando en ejecución: se cierra no dejándolo ser
  una plantilla.
- **El `actorUserId` del hijo es el del PADRE**, no el de la automatización llamada. Llamar a un
  flujo no puede ser una forma de hacer lo que el actor no podría hacer directamente. Es una
  divergencia deliberada con `avanzar`, que lee `run.automation.actorUserId`.
- **El hijo no hereda `vars`**: solo sus `argumentos`. Su interfaz es explícita.
- **La espera se detecta por ESTRUCTURA en ejecución** (`if (salida.esperar)`) y por el flag
  `NodeType.espera` en las guardas estáticas. `catalog.check.ts` afirma que los dos coinciden —
  ese check se comprobó quitando el flag a `wait.delay`, y falla como debe.
- **Alcance por `tenantId`** en el `where` de la búsqueda del hijo, nunca en un `if` posterior.
- **`cerrar()` arrastra a los hijos vivos**, y `cancelarRun` también — que **no** pasa por
  `cerrar` y hace su propio update, así que sin esa línea los hijos de un run cancelado a mano
  quedarían colgados y el barrido ya no los revive.

## Verificación

Sin base — es lo que compra el bucle propio:

1. `npx ts-node src/automations/subflujo.check.ts` → el `vars` del hijo vuelve al padre; los
   `argumentos` son lo único que ve; un paso ya `ok` no se repite; un fallo deja al hijo **sin
   cerrar** para que el reintento lo reanude; un nodo de espera aborta (con `wait.reply` **y**
   `wait.delay`); un bucle se corta **antes de crear la fila** (cero llamadas a la persistencia);
   los cuatro topes; y el enrutado coincide con `siguienteNodoId` en las dos ramas.
2. `llamadas.check.ts` → auto-llamada, A→B→A, A→B→C→A, profundidad estática, id inexistente,
   borrador, flujo que espera, y un grafo sano que no dice nada.
3. `barrido.check.ts` → un hijo sin señal se **corta**; el mismo run como primer nivel se revive.
4. `simulacion.check.ts` → la cadena entera se simula con los pasos del hijo marcados
   `deFlujo: {nombre, automationId}` y con su `tipo` —que solo viaja en ellos, porque el editor
   no tiene el grafo del hijo y sin eso la fila sale con el título en blanco—; un sub-flujo que
   espera aborta también en seco; un bucle también.
5. `catalog.check.ts` → el flag `espera` y lo que devuelve cada handler coinciden.
6. `npm run check` → **60/60**. `npm run build` limpio.

Con base (`prisma/sql/seed-43-subflujos.sql`) — **firmado el 2026-08-26**, 9 de 9:

7. `npx prisma migrate deploy` aplicó `20260826120000_ejecutar_flujo`, que era la única
   pendiente (la base venía de `20260821120000_segundo_factor_plataforma`).

**Primero lo que solo la base puede decir**, en una transacción con `ROLLBACK`, y salió bien
las tres veces:

- La unique `(parentRunId, parentNodeId)` rechaza el segundo hijo del mismo `(padre, nodo)`
  con `23505`. Y sus dos propiedades hermanas, que son las que la hacen usable en vez de
  romperlo todo: dos runs de primer nivel (los dos con `NULL`) **no** chocan, y el mismo nodo
  bajo **otro** padre sí entra.
- La FK auto-referencial: con padre → hijo → nieto y un paso en cada uno, borrar la
  **automatización** se llevó los cinco runs y los tres pasos por `CASCADE`, sin error.
- `AutomationRunStep` ya solo tiene `runId_fkey` y `tenantId_fkey`: la FK a `AutomationNode`
  no está.

8. `POST /automations/seed43-padre/run` → salió `El flujo llamado dijo: Hola QA Yo Mismo, soy
   el sub-flujo` (mensaje `sent` de verdad, por WAHA), y hay **dos** filas en `AutomationRun`:
   la segunda con `parentRunId` de la primera y `parentNodeId = 'seed43-p1'`.

   El contacto de prueba se creó a mano y se retiró después, porque WAHA está emparejado con un
   número real y un run de verdad **manda un WhatsApp de verdad**: `Contact` con el `waId` del
   propio número emparejado y `Conversation` sobre la conexión WAHA del tenant, las dos con
   `platform: 'waha'`. Ese último campo no es un detalle: con el `'whatsapp'` que pone el
   `DEFAULT` de la columna, `channelAdapter` elige el adaptador de Cloud API y el envío muere
   con «Token de acceso inválido» sin que nada diga que el transporte era el equivocado.
9. Padre e hijo en la misma conversación, los dos vivos a la vez, sin chocar con
   `(tenantId, waitingConversationId)`.
10. **La prueba de la unique nueva.** El hijo tarda milisegundos, así que matar el proceso a
    mitad no se puede cronometrar: se dejó la base **en el estado exacto que ese crash deja**
    —el hijo entero, y del padre borrado el paso del nodo de llamada con `updatedAt` a 11 min
    (`SIN_SENAL_MS` son 10)— y se dejó que el barrido lo reviviera solo. Resultado: **un** hijo,
    el mismo id y el mismo `createdAt`, y sus pasos **con su hora original** — no se re-ejecutó,
    se reanudó. `vecesRevivido` pasó a 1.
11. Activar `seed43-ciclo` → 400 «se llama a sí misma», con el ciclo dibujado.
12. La guarda de **ejecución**, que es la que esta feature necesita y no la de activación: con
    el padre **ya activo** se le cambió el nodo por debajo para que apuntara a `seed43-espera`
    (la carrera de dos admins que la spec describe). El run murió con «tiene un nodo de espera
    («Esperar respuesta») y una llamada no puede esperar», y el hijo que había quedado suelto
    lo cerró el barrido como `cortado` con «El flujo que lo llamó terminó antes».
    Por el camino se firmó también la guarda **estática**: con `seed43-espera` ya activa,
    activar al padre da el mismo mensaje.
13. `GET /automations/seed43-padre/llamables` trae `seed43-espera` **con su frase**, y las de
    otro tenant no salen.
14. `POST /automations/seed43-hijo/deactivate` → `usadaPor: [{id: 'seed43-padre'}]`.
15. Con 11 pasos de runs viejos del padre, se **guardó el grafo** (`PUT .../graph`, que borra y
    recrea todos los nodos con ids nuevos) y los 11 **siguen ahí**, los 11 apuntando ya a nodos
    que no existen. Es el arreglo silencioso de la migración medido **después** del acto que lo
    rompía, no antes.

## Dos bugs que solo apareció al correrlo, y los dos estaban en el mismo sitio

Los 60 checks pasaban y el motor no funcionaba. Los dos vivían en el **cableado** de
`automations.processor.ts`, que es justo lo que ningún check alcanza —necesita Nest, Postgres y
Redis—, y los dos los encontró el punto 8 a la primera.

**1. Toda primera llamada moría con «ya está en la cadena de llamadas».** El motor le pasaba a
`problemaAntesDeLlamar` el nivel **del hijo** (`cadena: [...cadena, automationId]`), y esa guarda
suma el uno ella misma (`cadena.includes(flujo.id)`), así que el hijo se encontraba a sí mismo.
`subflujo.check.ts` afirma el contrato contrario con su `cadena: ['padre']` —solo antepasados— y
por eso pasaba: el error no estaba en el módulo. El `+1` estaba escrito en dos sitios; ahora
está en uno, con nombre: `nivelDelHijo()`, y el check afirma la diferencia entre los dos niveles.

**2. Todos los hijos nacían con `parentNodeId: ''`.** `Ejecucion.nodeId` era opcional y el motor
era el único de los tres sitios que construyen una que no lo ponía (`subflujo.ts` y
`simulacion.ts` sí). Con eso la unique degeneraba —dos nodos de llamada en el **mismo** padre
habrían chocado entre sí— y la evidencia «vino de este nodo» salía en blanco. `nodeId` dejó de
ser opcional: lo exige el compilador, que cuesta menos que un check.

El frontend sacó el segundo el mismo día por otro camino —una pantalla donde un padre que llama
a dos sub-flujos ejecutaba el primero dos veces— y el orquestador lo confirmó en la base: tres
hijos, los tres con `parentNodeId` vacío. Dos caminos distintos, el mismo día, y **ninguno de los
dos fue un check**.

**El límite conocido de `npm run check`, dicho aquí porque es donde se cobró:** los 60 checks
cubren decisiones puras y no llegan al **cableado** — `automations.processor.ts` necesita Nest,
Postgres y Redis, así que lo único que lo prueba es correrlo. Los dos bugs eran de cableado, no
de lógica: un argumento pasado con un `+1` de más, y un campo que nadie ponía. Lo que sí se puede
hacer desde un check es **quitarle sitios a la duda**, y es lo que se hizo: el `+1` ahora tiene
nombre y el campo lo exige el compilador.

**`parent: null` en `/simular`** (enmienda de `contrato/43 §La ejecución`, 26 ago 2026): la
respuesta de la simulación se arma en `simulacion.ts` y no pasa por `conPadre`, así que el campo
llegaba **ausente**. Va `null` y no opcional porque un run real de primer nivel ya manda `null`:
admitir la ausencia dejaría dos codificaciones de «no tiene padre» y tres estados en pantalla
para una pregunta de dos casos. `simulacion.check.ts` lo afirma.

## Lo que NO está verificado, y por qué

**La carrera de verdad.** El punto 10 reproduce el ESTADO que deja un proceso muerto, no dos
workers empujando a la vez sobre la unique. Para eso hacen falta dos réplicas del backend contra
el mismo Redis, y aquí solo hay una. Lo que la unique impide está firmado; lo que no se ha visto
es a Postgres arbitrando entre dos escritores simultáneos.

**El mensaje duplicado no se puede ver desde el hijo**, porque `seed43-hijo` solo hace `var.set`
y no manda nada. Lo que el punto 10 afirma es lo equivalente y observable: que el hijo se
**reanuda** en vez de recrearse, con sus pasos intactos.

