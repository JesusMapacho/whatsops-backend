# 47-backend — Sondear una API y nombrar sus campos

**Objetivo:** que configurar un «Llamar a una API» deje de ser a ciegas. Llamarla **una vez**
desde el editor, ver los campos que devuelve, y poder **nombrar** los que interesan para
usarlos como `{{vars.saldo}}` en vez de `{{vars.api.json.data.0.account.balance}}`.
**Contrato:** `../GW/contrato/47-descubrir-la-api.md` §Formas — **escrito, sin implementar**.
**Depende de:** 18 (motor), 19 (editor), 42 (el contexto y el recorrido se reutilizan).
**Definición de hecho:** `POST /automations/:id/sondear` devuelve la lista de rutas de la
respuesta con su tipo y un ejemplo, y un `http.request` con `campos` deja cada campo nombrado
en `{{vars.<nombre>}}` — comprobado en una simulación en seco, sin frontend, y con
`npm run check` entero.

## Por qué

Hoy el operador configura la llamada, escribe a mano `{{vars.api.json.…}}` **adivinando la
forma**, activa el flujo y espera a que un cliente escriba para descubrir si acertó. El
`guardarComo` del nodo guarda la respuesta entera bajo un nombre, así que todo lo de después
es un recorrido largo por dentro de un JSON que nadie ha visto.

Y la ayuda del propio catálogo lo dice sin querer: «Nómbrala en "Guardar el resultado como" y
la respuesta se lee con `{{vars.<nombre>.json...}}`». Los tres puntos son el problema: **ahí
no hay nada que ayude a saber qué va después de `json.`**.

La 42 arregló la mitad de esto —ahora puedes simular y ver qué saldría— pero en seco la
llamada **no se hace**: el operador escribe a mano lo que cree que devuelve la API. O sea que
sigue siendo su suposición, solo que ahora se ve antes. Esta feature es la otra mitad: que la
suposición la ponga la API.

## Dos partes, y la segunda es la que quita el recorrido largo

### A. Sondeo — `POST /automations/:id/sondear`

Llama a la API **de verdad**, una vez, desde una acción de admin, y devuelve la forma de lo que
contestó. No un ejemplo inventado: la respuesta real, con este negocio y estos datos.

- Entrada: la config del nodo (`url`, `metodo`, `cuerpo`), más el mismo sobre que ya acepta
  `/simular` para armar el contexto (`texto`, `conversationId`, `messageId`). **Se reutiliza
  entero**: la URL lleva `{{contacto.waId}}` y sin contexto no se puede ni construir. No se
  inventa una tercera forma de armar contexto — ya se dijo eso en la 42.
- Va por `:id` y no suelto, aunque el nodo pueda estar sin guardar: `:id` es lo que da el
  alcance por `tenantId`. Un endpoint de «llama a esta URL» sin automatización detrás es un
  proxy abierto con sesión.
- Salida: `{ estado, ok, rutas, truncado, cuerpo?, respuesta?, error? }`. Cada ruta va
  **completa** (`vars.api.json.saldo`), con `tipo` de un juego cerrado, un `ejemplo`, y dos
  marcas: `deLista` y `alcanzable`.

**Las rutas no van a una pantalla nueva: van al autocompletado que ya existe**
(`rutas.ts` → `fusionar()`). Es el 90 % del valor y no cuesta pantalla: escribir
`{{vars.api.json.` en un mensaje tres nodos más abajo pasa a ofrecer lo que la API devolvió de
verdad. Mismo argumento que el cajón de ejecuciones en la 42 — si la forma encaja con lo que ya
hay, lo demás sale solo.

Y por eso el sondeo **habla el vocabulario de `aplanar`**, no uno propio. Las dos reglas que
`rutas.ts:238-247` ya decidió se respetan, y no por deferencia:

- **Los arrays no se expanden por índice.** Va con `deLista: true` y punto. Si el sondeo
  ofreciera `data.0.saldo` y el último run ofreciera `data`, el mismo campo tendría **dos
  vocabularios distintos** según de dónde salieron las rutas.
- **Las claves que la gramática no acepta** (`account-balance`, `Content-Type`) no se ofrecen,
  porque `{{vars.account-balance}}` no resuelve nunca y ofrecerla es ofrecer una mentira. Pero
  aquí tampoco se **descartan**: viajan con `alcanzable: false`, porque el operador ve ese campo
  en la respuesta de su API y si no lo ve en la lista concluye que el sondeo está roto. Se pinta
  apagado, con el motivo. Es la distinción `vacia`/`inalcanzable` de la 42, un nivel más arriba.

**Y `estado` viaja siempre, con `cuerpo` recortado cuando no hubo JSON.** Un sondeo acaba en 401
o en un HTML de error mucho más a menudo que en un JSON limpio — la primera vez, con el token
mal, es lo normal. Con solo `rutas: []`, la pantalla únicamente puede decir «no encontramos nada
en la respuesta», que es mentira cuando la verdad es «tu API contestó 401».

### B. `campos` en el nodo — lo que quita el recorrido

La config de `http.request` gana `campos: [{ nombre, ruta }]`, con la **ruta completa**, el mismo
vocabulario que devuelve el sondeo. Tras la llamada, cada uno queda en `{{vars.<nombre>}}`, y el
resto del flujo deja de hablar de la forma de la API.

**Necesita un `TipoCampo` nuevo en el catálogo, `'campos'`, y sin él la feature muere en el
editor**: el editor pinta la config de un nodo desde su `configSchema`, y `TipoCampo` es un juego
cerrado. Servido como `'json'`, el operador se encuentra un `<textarea>` donde teclear
`[{"nombre":"saldo","ruta":"vars.api.json.saldo"}]` a mano — peor que lo que tiene hoy, y hoy es
el problema que esto viene a resolver. Va en el contrato porque el catálogo dicta cómo se pinta.

Eso no es solo comodidad, y es el argumento que lo justifica: **hoy la forma de la API está
escrita en cada nodo que la usa**. Si el proveedor renombra un campo, hay que encontrar los
cinco sitios donde alguien tecleó la ruta larga. Con `campos`, la forma está en **un** sitio —
el nodo que llama— y lo de después habla de `{{vars.saldo}}`, que es un nombre del negocio y
no del proveedor. Es el mismo argumento que justificó las variables de negocio.

**La costura es `conSalidaYVariable`** (`contexto.ts`), que ya es el único sitio donde la
salida de un nodo se convierte en variables y ya lo comparten el motor y la simulación. Ahí,
`campos` se aplica junto a `guardarComo`. Consecuencias de elegir ese sitio, y las tres son la
razón de elegirlo:

1. **Cero casos especiales en el motor.** Ni el processor ni `simulacion.ts` se enteran. La ruta
   completa resuelve sola con `valorDe` sobre el contexto **ya con la salida del nodo dentro**:
   no hace falta lógica de prefijo en ninguna capa, que es justo la que se separaría al primer
   retoque si estuviera escrita dos veces.
2. **La 42 lo hereda gratis**: se puede probar en seco el mismo día.
3. Sirve para **cualquier** nodo que devuelva algo, no solo el de la API. No se ofrece en la
   pantalla para los demás todavía, pero el mecanismo no distingue — y no distinguir es
   menos código que distinguir.

## Seguridad: esto llama a una URL que teclea alguien

Es lo único de esta feature que no se puede hacer «lo más simple que funcione».

`http.request` ya tiene el agujero declarado en `catalog.ts:476`: «no hay defensa contra SSRF»,
con la nota de que media defensa sería peor que ninguna. Lo que cambia aquí es que la llamada
pasa a ser **síncrona y disparable desde una petición HTTP**, en vez de solo desde un run. El
riesgo no es nuevo, pero el camino sí, y se atiende:

- **Se reutiliza `waha/waha.url.ts`**, que ya resuelve esto para las URLs BYO: esquema
  `http`/`https`, resolver **todas** las direcciones del host y rechazar si alguna es privada o
  reservada (`isPrivateIp`). Lo que hay allí es `assertSafeFetchUrl`, atado a un `baseUrl` de
  WAHA; hace falta un hermano neutro `assertSafeOutboundUrl(url)` **en ese mismo archivo**,
  compartiendo `isPrivateIp` y `resolveAll`. Un tercer sitio con la misma lista de rangos
  privados es cómo se acaba con dos definiciones de «privado».
- El techo de TOCTOU que `waha.url.ts:47` ya nombra **se hereda tal cual** y se cita, no se
  vuelve a argumentar: entre resolver y llamar, el DNS puede cambiar.
- **Sin redirecciones**: `redirect: 'manual'`. Un 302 hacia `169.254.169.254` se salta toda la
  validación de arriba, que es el clásico.
- Timeout de 10 s y tope de cuerpo, como el nodo. Y **el sondeo no manda credenciales**: hoy el
  nodo tampoco tiene cabeceras, así que no hay nada que filtrar — pero cuando las tenga
  (que las va a tener), esto se relee.
- `automations:manage`, que es el mismo corte que el resto del módulo.

## Lo que se arregla de paso

El comentario del handler dice «Se guarda un recorte: el contexto va a una columna Json que se
lee entera en cada paso, y una respuesta de 2 MB la arrastraría por todo el run». **Solo recorta
`texto`.** `json` se guarda entero, así que una respuesta grande sí se arrastra — el comentario
describe una protección que no existe, que es peor que no tener comentario.

`campos` es justo la respuesta correcta: nombrando lo que se usa, se puede guardar **solo eso**
y no la respuesta entera. Se decide al escribir el contrato si `campos` **sustituye** al
`json` completo en el contexto o convive con él; sustituirlo cambia una forma que ya cruza, así
que va con enmienda.

## Lo que NO se construye

- **Un catálogo de APIs conocidas**, ni plantillas por proveedor. Es un catálogo que envejece.
- **`map` sobre listas.** El sondeo marca la lista con `deLista` y ahí se para; recorrer los N
  elementos es otra feature, y hoy se hace con `code.run`. Es la misma frontera que la de no
  expandir por índice — *ponytail: techo conocido, camino = una función `mapear` en
  `expresiones.ts`*.
- **Guardar el resultado del sondeo.** Es de usar y tirar: se llama, se eligen campos, se
  guarda el nodo. Nada que persistir, nada que invalidar.
- **Autenticación de la API** (cabeceras, tokens). Es una feature con su propio problema —dónde
  se cifra ese secreto— y mezclarla aquí convierte un sondeo en un almacén de credenciales.
- **Reintentos.** Si la API no contesta, se dice y ya: el operador está delante mirando.

## Restricciones

- **`nombre` pasa por `NOMBRE_VAR`.** Un «mi total» o un «a.b» se guardarían tan ricamente y
  no resolverían nunca, en silencio — es el mismo control que ya lleva `guardarComo`, y por
  eso va en el mismo sitio, `validarConfig`.
- **`ruta` se lee con `valorDe`**, no con un acceso a mano: es lo que ya bloquea
  `constructor` y la cadena de prototipos, y aquí la ruta la escribe el operador.
- **El aplanado tiene tope**: profundidad y número de rutas. Una respuesta con 40 000 claves no
  puede tumbar el editor, y `truncado: true` lo dice en vez de mentir por omisión.
- **El sondeo NO crea ninguna fila.** Misma regla que la 42: no es un run.
- **`tenantId` sale del `@CurrentUser()`**, y la automatización se busca con él en el `where`.

## Verificación

1. `npx ts-node src/automations/sondeo.check.ts` → `sondeo.check.ts OK`. Y
   `contexto.check.ts`, que es donde se afirma `campos`: es el único sitio donde la salida de
   un nodo se convierte en variables, y lo comparten el motor y la simulación.
2. `npm run check` → 58/58. `npm run build` limpio.
3. Con la base levantada, cargar el fixture:

   ```bash
   docker exec -i whatsops-backend-postgres-1 psql -U whatsops -d whatsops      -f - < prisma/sql/seed-47-sondeo.sql
   ```

   Deja `[seed47] Sondeo y campos con nombre` en borrador: trigger → `http.request` con
   `campos` → un envío que dice `Tu saldo es {{vars.saldo}}, {{vars.quien}}.` **Ese texto es
   la feature**: el nodo de después no menciona la forma de la API. Va aparte del seed de la
   42 a propósito — aquel está citado textualmente en su verificación, y meterle un nodo más
   invalidaría esas frases.

4. Sobre `seed47-auto` (verificado el 2026-08-25, 12 de 12):
   - Sin `guardarComo` → 400: «Ponle nombre al resultado antes de sondear».
   - **SSRF, las cinco**: `http://127.0.0.1:3000/health`, `http://169.254.169.254/…`,
     `http://[::1]/`, `http://10.0.0.1/` y `file:///etc/passwd` → las cinco con `estado: 0`,
     `rutas: []` y motivo. Las cuatro primeras dicen «apunta a una dirección interna o
     reservada»; la quinta, «solo http:// o https://».
   - Un host que no resuelve → `estado: 0` con el motivo nombrando el host, **no un 500**.
   - La URL se interpola **antes** de validar y llamar: la plantilla ya no aparece en el error.
   - **`campos` en seco** (contrato §8): simular con
     `httpRespuestas: { 'seed47-n1': { data: [{ saldo: 1234 }], cliente: { nombre: 'Leticia' } } }`
     deja el último paso en `Tu saldo es 1234, Leticia.` **Esa es la prueba de que la costura
     está bien elegida**: no hubo que tocar el processor para que funcione en seco.
   - Y `vars.api.json` sigue entero: `campos` **añade** nombres, no los sustituye.
   - El sondeo no crea ninguna fila, contadas antes y después.
   - Con el `tenantId` de otro tenant → 404.

5. **Lo que NO se pudo verificar aquí y queda dicho**: una llamada que llegue a contestar.
   Todas las pruebas de arriba fallan antes del `fetch` —a propósito, para no depender de una
   API ajena—, así que el camino feliz (rutas reales, `truncado`, `respuesta`) está cubierto
   por `sondeo.check.ts` sobre objetos, no contra una API de verdad. La primera pasada con
   red debe mirar eso, más el 302 (que no se sigue) y un 401 con cuerpo HTML.

## El orden de despliegue, que no es el habitual

El sondeo no rompe nada. **`campos` sí tiene orden**, y es lo contrario de lo que este contrato
suele poder prometer: **no se sirve en el `configSchema` hasta que el editor sepa pintar valores
compuestos**.

El motivo lo midió el frontend en su propio código, no lo supuso: un editor que no conoce el
`tipo` lo pinta como un campo de texto editable, `String(v)` sobre un array de objetos da
`"[object Object]"`, y en cuanto el operador lo toca, el `setConfig` escribe esa cadena **encima
del array** y guardar lo persiste. No degrada feo: **borra en silencio una configuración que el
operador ni siquiera puede ver**.

Está en el contrato §Compatibilidad con los dos pasos. Aquí lo que importa es la consecuencia
para esta capa: **servir `campos` en el catálogo es el último paso de la 47, no el primero**, y
el `tipo: 'campos'` no se añade al `configSchema` mientras la app no esté desplegada.

La ventana es más estrecha de lo que suena, y conviene no venderla más ancha: como el
`configSchema` lo sirve esta API, un editor que **arranca** siempre recibe el catálogo al día.
Lo que queda expuesto es un **bundle cacheado** en una pestaña que nadie ha recargado. Sigue
mereciendo el orden, porque lo que se perdía se perdía en silencio — pero decide eso, no la
frecuencia.

Y el día que se sirva `campos`, **lo primero que hay que mirar es esa rama del editor**: hoy
compila pero no se ha visto ejecutar, porque para que caiga en ella hace falta justo este paso.

## De dónde salieron la mitad de estas decisiones

El contrato se escribió **con** el frontend, antes de tocar código, y cinco de sus puntos son
correcciones suyas a la primera versión de esta spec: los índices de lista (que chocaban con una
decisión ya escrita en `aplanar`), las claves inalcanzables (que aquí se descartaban en silencio)
y el `estado`, que faltaba entero. La cuarta —el `TipoCampo`— es una restricción de su editor
que desde aquí no se ve, y sin ella la feature se entrega inservible. La quinta es el orden de
despliegue de arriba, que salió de que fueran a comprobar qué hace hoy su pintor con un `tipo`
desconocido en vez de fiarse de que «caería en algo legible» — que es lo que decía mi
§Compatibilidad.

Y un desglose más: `truncado` era un booleano, y «se alcanzó el tope de rutas» y «se alcanzó el
de profundidad» son dos frases distintas en pantalla. Con un booleano solo se puede decir «hay
más», que es la respuesta vaga que estos dos contratos ya rechazaron dos veces — el `rutas: []`
que tapaba un 401 y el `bloqueado` que tapaba tres cosas.

Es el mismo patrón que en la 42: preguntar antes de que nadie dibuje nada ahorró dos rehacer.

**Renombrar `guardarComo` después de sondear invalida las rutas elegidas**, incluidas las de
`campos`. Está en el contrato §1 como consecuencia declarada y no se compensa: hoy pasa
exactamente lo mismo con las rutas que se teclean a mano, y compensarlo aquí crearía dos
comportamientos para el mismo renombrado.
