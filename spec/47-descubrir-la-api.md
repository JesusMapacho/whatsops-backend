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
  *(Enmendado el 27 ago 2026: los dos abren **un** elemento, `data.0.saldo`, y los dos paran
  ahí. La regla de un solo vocabulario no cambia — cambian los dos a la vez. Ver abajo.)*
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

## Abrir las listas, y que `campos` resuelva la tubería (enmienda, 27 ago 2026)

Dos cosas que se enmiendan juntas porque separadas dejan medio camino, que es el que confunde.
El contrato las lleva en el §3 reescrito y el §16 nuevo.

**1. El sondeo baja UN elemento dentro de cada lista** (`sondeo.ts`, la rama de hoja de
`aplanarRespuesta`): la hoja de la lista se sigue emitiendo igual —es sobre ella donde se aplican
`| cuenta` y `| unir`— y además se recorre `v[0]` con la ruta `.0`, si es un objeto. Tres
decisiones que el sitio no dice solo:

- **Uno, no todos.** Cien elementos por diez claves son mil rutas. El argumento del scroll
  infinito de `aplanar` sigue en pie; lo que se retira es la conclusión de que para bajar hacía
  falta `code.run`.
- **El índice NO gasta profundidad.** Un índice no es un nivel del modelo de datos del operador,
  es un artefacto. Y la cuenta lo confirma: `MAX_PROFUNDIDAD` son tres tramos, así que
  contándolo `results.0.name` se los gastaría los tres.
- **Solo si el elemento es un objeto.** `topics: ["fire","water"]` no tiene claves que enseñar.

**2. Un campo `campos` resuelve expresiones** (`contexto.ts`, y `catalog.ts` en `argumentosDe`).
`valorDelCampo` **ya existía** en `comparadores.ts` y hacía exactamente esto; se **mueve** a
`contexto.ts` y los tres sitios la comparten, en vez de tener tres copias de la regla de
resolución que se separan al primer retoque. La dirección de dependencias ya era esa.

> **Esto era un fallo silencioso en producción, no una mejora.** El editor autocompleta funciones
> en las filas de un campo `campos` **por tipo de campo**, no por nodo, así que ya ofrecía
> `| cuenta` ahí. El servidor resolvía con `valorDe` pelado: la ruta con tubería no casa ninguna
> clave, sale `undefined`, y el `?? null` la dejaba en `null` **sin que nada lo dijera**. El
> editor sugería algo que el motor tiraba.
>
> Y estaba en **dos** sitios, no en uno: `flow.call.argumentos` es el mismo `tipo: 'campos'` y
> también resolvía pelado. El frontend reportó el primero; el segundo salió de buscar quién más
> comparte el tipo, y se arregla en la misma pasada porque es la misma línea.

**Lo que no cambia:** `ok` y la clasificación del §11; el `?? null` de `campos`, que deja la
variable en `null` en vez de omitirla; el bloqueo de `constructor`, porque `valorDelCampo` sigue
recorriendo con `valorDe`; y la rama de clave inalcanzable de `aplanarRespuesta`, donde **no** se
baja a propósito —un tramo intermedio inválido hace que nada de lo de dentro resuelva—.

## `variables` en la respuesta del sondeo (enmienda, 26 ago 2026)

El sondeo se lanza desde la pestaña de configuración, donde el sobre de prueba —el mismo de
`/simular`— está **vacío**. Así que una URL con `{{contacto.waId}}` se llama con ese hueco en
blanco, la API contesta un 404, y **el operador da por rota su API** cuando lo que falta es el
contacto.

`/sondear` devuelve `variables: [{ruta, estado}]` con el mismo colector que la 42 usa en los
pasos, una capa más arriba: en la URL y el cuerpo. **Viaja siempre, incluidos los cuatro caminos
de fallo** — que es justo donde hace falta, porque es donde el 404 no se explica solo.

Se descartó el aviso fijo en el `ayuda` del campo, que era la otra opción: un cartel que sale
siempre no dice **cuál** variable salió vacía en **este** sondeo, y se deja de leer a la tercera
vez. Lo levantó el frontend probando el flujo real de trabajo, no una prueba.

Contrato: `../GW/contrato/47-descubrir-la-api.md` §12.

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
- **`map` sobre listas.** Recorrer los **N** elementos es otra feature, y hoy se hace con
  `code.run` — *ponytail: techo conocido, camino = una función `mapear` en `expresiones.ts`*.
  *(Enmendado el 27 ago 2026: lo que sí se hace es abrir el primero. La frase original decía que
  el sondeo «marca la lista con `deLista` y ahí se para», y de ahí se leía que para sacar un
  campo de un elemento hacía falta `code.run`. Eso era falso: `valorDe` indexa arrays desde
  siempre.)*
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
2. `npm run check` → 60/60. `npm run build` limpio.
3. Con la base levantada, cargar el fixture:

   ```bash
   docker exec -i whatsops-backend-postgres-1 psql -U whatsops -d whatsops      -f - < prisma/sql/seed-47-sondeo.sql
   ```

   Deja `[seed47] Sondeo y campos con nombre` en borrador: trigger → `http.request` con
   `campos` → un envío que dice `Tu saldo es {{vars.saldo}}, {{vars.quien}}.` **Ese texto es
   la feature**: el nodo de después no menciona la forma de la API. Va aparte del seed de la
   42 a propósito — aquel está citado textualmente en su verificación, y meterle un nodo más
   invalidaría esas frases.

4. Sobre `seed47-auto`, los doce de la primera pasada (2026-08-25) y **re-corridos el
   2026-08-26**: sin `guardarComo` → 400; los cinco SSRF; el host que no resuelve; la URL
   interpolada antes de validar; `campos` en seco; `vars.api.json` entero; cero filas; y el 404
   de otro tenant. El detalle de cada uno está en los puntos 5 y 6, que es donde se firmaron con
   la base y la red arriba.

5. **Con red, firmado el 2026-08-26.** Hasta aquí todas las pruebas fallaban **antes** del
   `fetch` —a propósito, para no depender de una API ajena—, así que el camino feliz estaba
   cubierto solo por `sondeo.check.ts` sobre objetos. Ya no.

   Ningún servidor local sirve para esto y **eso es el diseño**: `assertSafeOutboundUrl` resuelve
   el host y rechaza toda IP privada, así que un `localhost` de pruebas es indistinguible del
   SSRF que la guarda existe para parar. Las fixtures son APIs públicas.

   Primero los rechazos, que son los que no pueden fallar:

   | Caso | URL | Salió |
   |---|---|---|
   | los cuatro SSRF directos | `127.0.0.1:3000`, `169.254.169.254`, `[::1]`, `10.0.0.1` | `estado: 0`, `rutas: []`, «apunta a una dirección interna o reservada» |
   | esquema | `file:///etc/passwd` | `estado: 0`, «solo http:// o https://» |
   | **DNS que resuelve a privada** | `http://localtest.me/` (→ `127.0.0.1`) | `estado: 0`, mismo motivo — se juzga la IP, no el nombre |
   | **pública que redirige a privada** | `httpbin.org/redirect-to?url=http://169.254.169.254/` | `estado: 302`, `ok: false`, «no sigue redirecciones» |
   | 302 pelado | `httpbin.org/status/302` | igual |
   | host que no resuelve | `api.ejemplo.invalid` | `estado: 0` nombrando el host, **no un 500** |

   Y después el camino feliz, que es lo que no tenía ninguna cobertura contra red:

   | Caso | URL | Salió |
   |---|---|---|
   | 2xx con JSON | `httpbin.org/json` | `ok: true`, cuatro rutas reales, `deLista: true` en `slideshow.slides`, `respuesta` entera |
   | `truncado: 'rutas'` | un PR de `api.github.com` | `ok: true`, exactamente 200 rutas (`MAX_RUTAS`) |
   | `truncado: 'profundidad'` | `.../repos/nestjs/nest/branches/master` | `ok: true`, 60 rutas, `commit.commit.author` cortado como `objeto` |
   | **caso 3 del contrato** | `api.github.com/users/octocat/orgs` (`[]`) | `estado: 200`, **`ok: true`**, `rutas: []` |
   | no-2xx con cuerpo | `api.github.com/user` | `estado: 401`, **`ok: false`**, `rutas: []`, `cuerpo` con el recorte |
   | cuerpo no-JSON | `httpbin.org/html` | `estado: 200`, `ok: false`, `cuerpo` con el HTML, **sin** `respuesta` |

   Las dos filas del medio son **la** prueba de que el caso 3 no se colapsa con el 401: las dos
   traen `rutas: []` y solo `ok` las distingue. Es el desglose que este contrato peleó.

   > **Las dos últimas filas quedaron desactualizadas el 27 ago 2026**, con el arreglo del
   > punto 8: el 401 de `api.github.com/user` trae ahora `rutas` con `message` y
   > `documentation_url` dentro (contrato §15). El caso 3 sigue siendo el único con `rutas: []`,
   > así que el desglose no se pierde — al revés, las dos pantallas ya ni se parecen, y `ok`
   > sigue siendo lo único que clasifica.

6. Y lo que ya estaba, revisado otra vez con la base arriba:
   - Sin `guardarComo` → 400 «Ponle nombre al resultado antes de sondear».
   - La URL se interpola **antes** de validar: con `{{contacto.waId}}` vacío, el error nombra el
     host resuelto y la plantilla ya no aparece; el hueco viaja en `variables` como `vacia`.
   - **`campos` en seco** (contrato §8): simular con
     `httpRespuestas: { 'seed47-n1': { data: [{ saldo: 1234 }], cliente: { nombre: 'Leticia' } } }`
     dejó el último paso en `Tu saldo es 1234, Leticia.` **Esa es la prueba de que la costura
     está bien elegida**: no hubo que tocar el processor para que funcione en seco.
   - Y `vars.api.json` sigue entero: las claves quedaron en `['api', 'quien', 'saldo']`, o sea
     que `campos` **añade** nombres, no los sustituye.
   - El sondeo no creó ninguna fila: `7 | 19 | 1709` (runs, pasos, msgs) antes y después.
   - Con el `tenantId` de otro tenant → 404.

7. **Lo que sigue sin verificarse.** Un 401 cuyo cuerpo sea **HTML** en una sola llamada: no
   encontré un endpoint público estable que lo dé, así que la afirmación va partida en dos
   —`api.github.com/user` pone el 401 con `cuerpo`, `httpbin.org/html` pone el recorte de HTML— y
   las dos mitades están firmadas. Lo que falta es verlas juntas, que es un caso de forma, no de
   código: `cuerpo` sale del mismo recorte a 2000 en los dos.

8. **El `slice` de 64 KB iba antes del `JSON.parse`. Arreglado y firmado el 27 ago 2026.** Lo
   encontró la sesión del frontend: el panel decía «tu API contestó 200» pintado como error. El
   servicio recortaba el cuerpo a 64 KB **antes** de parsearlo, así que toda respuesta JSON
   válida más grande se partía a media cadena, `JSON.parse` reventaba y salía
   `estado: 200, ok: false`. Y el recorte no protegía nada: `res.text()` ya había materializado
   el cuerpo entero.

   De paso, el `if (!ok)` devolvía `rutas: []` aunque el cuerpo del error fuera JSON — la
   enmienda §15 del contrato. Ahora se aplana igual, y `ok` sigue siendo lo único que clasifica.

   Las siete llamadas, contra `POST /automations/seed47-auto/sondear` con sesión y CSRF de
   verdad, no contra la función suelta:

   | URL | Antes | Salió |
   |---|---|---|
   | `pokeapi.co/api/v2/pokemon?limit=2000` (93 KB) | `estado: 200`, **`ok: false`**, `rutas: []` | **`ok: true`**, `count`/`next`/`previous`/`results`, `results` con `deLista: true` y ejemplo «1351 elementos» — **no** 1351 filas |
   | `api.github.com/repos/nope/nope-no-existe-xyz` | `404`, `rutas: []` | `404`, `ok: false`, **tres rutas** (`message`, `documentation_url`, `status`), más `cuerpo` y `respuesta` |
   | `api.github.com/user` | `401`, `rutas: []` | `401`, `ok: false`, las mismas tres rutas — la fila del punto 5 que esto desactualizó |
   | `httpbin.org/html` | `200`, `ok: false`, `cuerpo` | **igual**: el HTML no parsea y el arreglo no lo convierte en un falso «bien» |
   | `httpbin.org/json` | `ok: true`, cuatro rutas | igual, sin cambio |
   | `api.github.com/users/octocat/orgs` (`[]`) | `200`, `ok: true`, `rutas: []` | igual — sigue siendo el **único** caso con `rutas: []` y `ok: true` |
   | `httpbin.org/status/302` | `302`, `error` puesto | igual: el bloque de 3xx no se tocó, ahí no hay cuerpo que aplanar |

   La regresión que importa es la primera fila; las tres últimas están para afirmar lo que **no**
   cambió. `AutomationRun` y `AutomationRunStep` siguieron en `7 | 19` antes y después: el sondeo
   sigue sin crear ninguna fila.

   `sondeo.check.ts` no gana ningún assert, y es a propósito: el bug vivía en el orden de dos
   líneas del servicio, no en `aplanarRespuesta`, y un check que no toca red no puede verlo. Lo
   que sí queda es el `ponytail:` de `automations.service.ts`, que nombra por qué el recorte no
   puede volver a subir por encima del parseo.

   > **Y esto tapaba una verificación entera, no solo una respuesta.** El árbol de la app —el §13
   > del contrato— llevaba desde el 26 ago marcado «escrito, sin ver en pantalla», con «la API
   > estaba caída» como motivo. Era falso: **toda** respuesta de más de 64 KB salía clasificada
   > como fallo, así que la pantalla del árbol no se pintaba nunca con una API de verdad, y quien
   > lo intentara a mano con una API grande veía la pantalla de error sin saber por qué. Se vio
   > por primera vez el 27 ago, con este arreglo dentro. El aviso que deja: un bug de
   > clasificación no cuesta una respuesta, cuesta la pantalla que cuelga de ella — y el motivo
   > que se apunta al aparcar una verificación puede ser el síntoma de otra cosa.

9. **Abrir las listas y la tubería en `campos`. Firmado el 27 ago 2026.** Contra
   `POST /automations/seed47-auto/sondear` con sesión y CSRF de verdad:

   | URL | Salió |
   |---|---|
   | `pokeapi.co/api/v2/pokemon?limit=2000` | seis rutas: las cuatro de antes **más** `results.0.name` y `results.0.url`. Una vez, no 1351. `results` sigue con `deLista` y ejemplo «1351 elementos» |
   | `api.github.com/repos/nestjs/nest` | 126 rutas. **`topics` sale como hoja `lista` y NO se abre** —es lista de escalares—, mientras `owner`, `license` y `organization` sí bajan como objetos |
   | `httpbin.org/json` | `slideshow.slides` abre `slides.0.title` y `slides.0.type` |

   Y la prueba de que la ruta que se ofrece **no es una ruta muerta**: simular en seco
   `seed47-auto` con `httpRespuestas: { 'seed47-n1': { data: [{ saldo: 1234 }], cliente: {…} } }`
   dejó el último paso en `Tu saldo es 1234, Leticia.`. O sea que `vars.api.json.data.0.saldo`
   —con índice— resuelve por el camino real de `campos`, que es justo lo que la pantalla decía
   que no se podía.

   La tubería en `campos` la afirman `contexto.check.ts` y `catalog.check.ts` sobre los dos
   sitios, y **los rompí a propósito** volviendo a `valorDe` para ver el fallo con sus palabras —
   `actual: null, expected: 1`. Un check que no se ha visto fallar no prueba nada.

   **Y firmada también por el camino real**, que es lo que aquí no se podía hacer sin reescribir
   la config del nodo en base: la sesión del frontend guardó tres filas de `campos` contra la API
   —`name` → `results.0.name`, `results_name` → `results | campo:"name" | unir:", "`, `cuantos` →
   `results | cuenta`— y simuló en seco con tres elementos. El contexto final trajo
   `{"cuantos": 3, "name": "bulbasaur", "results_name": "bulbasaur, ivysaur, venusaur"}`. Guardar
   no dio 400: `validarConfig` comprueba `NOMBRE_VAR` sobre el **nombre** y no la forma de la
   `ruta`, así que una con comillas y espacios pasa — que es justo lo que hacía falta aquí, y
   está dicho para que nadie lo cierre por parecer un descuido.

   > **Un techo que esta enmienda acerca, dicho y no tocado.** `MAX_RUTAS` son 200, y abrir las
   > listas añade filas: un `repos/nestjs/nest` normal ya se planta en 126. `truncado: 'rutas'`
   > sigue avisando cuando se topa, así que no hay nada silencioso; lo que cambia es que ahora se
   > topa antes. No se sube porque no hay ninguna respuesta real que lo pida — *ponytail: si
   > alguien trae una que se corte de verdad, el número está en `sondeo.ts` y es una línea*.

   Un aviso que salió de escribir el check: la primera versión afirmaba `a.b.c.0.d` y **falló**.
   No era el código: `a.b.c` ya se gasta los tres tramos de `MAX_PROFUNDIDAD`, así que ese caso
   topa por profundidad tanto si el índice cuenta como si no. El caso que de verdad distingue es
   `a.b` + lista, y está escrito así. Abrir listas no salta el tope: `a.b.c.0` sale cortado y con
   `truncado: 'profundidad'`, y eso también se afirma.

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
