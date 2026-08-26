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
4. `simulacion.check.ts` → la cadena entera se simula con los pasos del hijo marcados `deFlujo`;
   un sub-flujo que espera aborta también en seco; un bucle también.
5. `catalog.check.ts` → el flag `espera` y lo que devuelve cada handler coinciden.
6. `npm run check` → **60/60**. `npm run build` limpio.

Con base (`prisma/sql/seed-43-subflujos.sql`) — **PENDIENTE: no se pudo correr**, ver abajo:

7. Aplicar la migración: `npx prisma migrate deploy` (o el `psql -f` del archivo).
8. `POST /automations/seed43-padre/run` con una conversación: sale
   `El flujo llamado dijo: Hola <nombre>, soy el sub-flujo`, y hay **dos** filas en
   `AutomationRun`, la segunda con `parentRunId` de la primera.
9. Padre e hijo en la misma conversación **sin chocar** con `(tenantId, waitingConversationId)`.
10. Matar el proceso a mitad del hijo y reencolar: **cero mensajes duplicados**, y el hijo se
    reanuda desde su `currentNodeId`. Es la prueba de la unique nueva, y la única que la prueba.
11. Activar `seed43-ciclo` → 400 con «se llama a sí misma».
12. Activar `seed43-espera` y volver a disparar al padre apuntándolo: la guarda de **ejecución**
    para al padre con el nombre del nodo de espera.
13. `GET /automations/seed43-padre/llamables` trae `seed43-espera` **con su frase**, no lo
    esconde. Y no trae flujos de otro tenant.
14. `POST /automations/seed43-hijo/deactivate` contesta con `usadaPor: [{id: 'seed43-padre'}]`.
15. Editar el grafo de `seed43-padre` y volver a mirar un run anterior: **sus pasos siguen ahí**.

## Lo que NO está verificado, y por qué

**Nada de lo que necesita base.** Docker estaba parado cuando se terminó esto —el usuario había
bajado los servidores—, así que **la migración no se ha aplicado ni una vez** y los puntos 7 a 15
están sin correr. Lo que hay es: el esquema valida (`npx prisma validate`), el cliente se
regenera, el proyecto compila y los 60 checks pasan.

Eso deja sin comprobar, en concreto, lo que solo la base puede decir: que la unique
`(parentRunId, parentNodeId)` de verdad impide el segundo hijo, que la FK auto-referencial con
`CASCADE` no rompe el borrado de una automatización, y que retirar la FK de
`AutomationRunStep.nodeId` no deja ninguna consulta huérfana. **La primera pasada con la base
arriba tiene que empezar por ahí**, no por el camino feliz.
