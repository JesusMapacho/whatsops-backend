// Check de la simulación en seco (feature 42).
// Correr: npx ts-node src/automations/simulacion.check.ts
//
// Lo que este archivo tiene que atrapar es UNA cosa: que un nodo consiga provocar un efecto
// externo en seco. Por eso `fetch` se sustituye por una función que revienta y no se repone:
// si algún día un tipo de nodo empieza a llamar a la red desde una simulación, esto falla
// aquí y no en el teléfono de un cliente.
//
// Lo que NO se prueba aquí (necesita base, y va en la spec): el alcance por `tenantId`, que
// es del servicio, y que no se cree ninguna fila, que se comprueba contando filas.
import * as assert from 'node:assert';
import { EntradaSimulacion, dobles, entradaSegunTrigger, simular } from './simulacion';

// Una simulación no puede llamar a la red. Se rompe `fetch` para todo el archivo.
(global as unknown as { fetch: unknown }).fetch = () => {
  throw new Error('La simulación llamó a la red');
};

type Nodo = { id: string; type: string; isRoot: boolean; config: unknown };
type Arista = { fromNodeId: string; toNodeId: string; branch: string | null };

const BASE: Omit<EntradaSimulacion, 'nodes' | 'edges' | 'contexto'> = {
  tenantId: 't1',
  actorUserId: 'u1',
  conversationId: 'c1',
  ajustes: { precio: '100' },
  respuestas: [],
  httpRespuestas: {},
  permitirHttpReal: false,
  frenoEnvio: null,
};

const CTX = {
  mensaje: { texto: 'hola', wamid: null },
  contacto: { id: 'k1', nombre: 'Ana', waId: '52811' },
  conversacion: { id: 'c1' },
  disparador: { tipo: 'message.inbound', texto: 'hola' },
  nodos: {},
  vars: {},
};

const correr = (nodes: Nodo[], edges: Arista[], extra: Partial<EntradaSimulacion> = {}) =>
  simular({ ...BASE, nodes, edges, contexto: { ...CTX }, ...extra });

const trigger: Nodo = { id: 'n0', type: 'message.inbound', isRoot: true, config: {} };

// Los handlers son async, así que el recorrido también: todo el check vive dentro de `main`
// porque este repo compila a CommonJS y ahí el `await` de nivel de módulo no existe.
async function main() {

  // --- El envío no sale, y el resumen va interpolado ---------------------------------------
  // Es la mitad del valor de la feature: ver el texto YA resuelto es donde se descubre que una
  // variable iba a salir vacía, en vez de descubrirlo cuando lo lee un cliente.
  {
    const envio: Nodo = {
      id: 'n1',
      type: 'message.send',
      isRoot: false,
      config: { texto: 'Hola {{contacto.nombre}}, tu total es {{vars.total}}.' },
    };
    const r = await correr([trigger, envio], [{ fromNodeId: 'n0', toNodeId: 'n1', branch: null }]);

    assert.strictEqual(r.status, 'done');
    assert.strictEqual(r.simulado, true);
    assert.strictEqual(r.id, 'simulacion', 'id fijo: nunca puede casar con un run del historial');
    assert.strictEqual(r.pendiente, null);
    assert.strictEqual(r.steps.length, 2, 'el trigger cuenta como paso, igual que en el motor');
    assert.strictEqual(r.steps[0].status, 'skipped', 'los triggers no se ejecutan');

    const paso = r.steps[1];
    assert.strictEqual(paso.status, 'ok');
    assert.strictEqual(paso.efectos.length, 1);
    assert.strictEqual(paso.efectos[0].servicio, 'messaging');
    assert.strictEqual(paso.efectos[0].metodo, 'send');
    // Una variable que existe pero no resuelve se sustituye por VACÍO, no por el literal: es el
    // contrato de `interpolar` y aquí es justo lo que hay que poder ver.
    assert.strictEqual(paso.efectos[0].resumen, 'Hola Ana, tu total es .');
    assert.strictEqual(paso.efectos[0].bloqueado, undefined, 'sin freno, no hay campo bloqueado');
    // El id del paso es único dentro de la respuesta: el frontend hace `track p.id`, y dos
    // pasos con el mismo id dejarían la lista pintando cualquier cosa.
    assert.strictEqual(new Set(r.steps.map((p) => p.id)).size, r.steps.length);
  }

  // --- Vacía e inalcanzable son DOS avisos, y el paso los distingue -------------------------
  // En pantalla `Hola ` y `Hola` son indistinguibles, así que sin `variables` el operador no
  // puede saber si ahí había una variable. Y los dos casos se arreglan distinto: una vacía se
  // rellena, una inalcanzable está mal escrita y no va a resolver por mucho que se rellene.
  {
    const envio: Nodo = {
      id: 'n1',
      type: 'message.send',
      isRoot: false,
      config: { texto: '{{contacto.nombre}} / {{vars.total}} / {{vars.mi campo}}' },
    };
    const r = await correr([trigger, envio], [{ fromNodeId: 'n0', toNodeId: 'n1', branch: null }]);

    // `{{vars.mi campo}}` tiene un espacio: no casa la gramática y sale LITERAL, con llaves.
    assert.strictEqual(r.steps[1].efectos[0].resumen, 'Ana /  / {{vars.mi campo}}');
    assert.deepStrictEqual(r.steps[1].variables, [
      { ruta: 'contacto.nombre', estado: 'ok' },
      { ruta: 'vars.total', estado: 'vacia' },
      { ruta: 'vars.mi campo', estado: 'inalcanzable' },
    ]);
    // El trigger no interpola nada, así que no inventa avisos.
    assert.deepStrictEqual(r.steps[0].variables, []);
  }

  // La misma ruta dos veces en un nodo es UN aviso, no dos: la franja de la pantalla se leería
  // como si hubiera dos problemas.
  {
    const envio: Nodo = {
      id: 'n1',
      type: 'message.send',
      isRoot: false,
      config: { texto: '{{vars.total}} y otra vez {{vars.total}}' },
    };
    const r = await correr([trigger, envio], [{ fromNodeId: 'n0', toNodeId: 'n1', branch: null }]);
    assert.deepStrictEqual(r.steps[1].variables, [{ ruta: 'vars.total', estado: 'vacia' }]);
  }

  // --- El freno de la ventana de 24 h se ENSEÑA -------------------------------------------
  // Una simulación que no lo enseña miente por optimista, que es el fallo que la feature existe
  // para evitar. Y va en un campo, no dentro del texto: como campo la pantalla lo pinta en rojo.
  {
    const envio: Nodo = { id: 'n1', type: 'message.send', isRoot: false, config: { texto: 'hola' } };
    const r = await correr([trigger, envio], [{ fromNodeId: 'n0', toNodeId: 'n1', branch: null }], {
      frenoEnvio: 'Fuera de la ventana de 24 h.',
    });
    assert.strictEqual(r.steps[1].efectos[0].bloqueado, 'Fuera de la ventana de 24 h.');
    assert.strictEqual(r.status, 'done', 'el freno se enseña, no corta la simulación');
  }

  // --- El CRM tampoco se toca --------------------------------------------------------------
  {
    const trato: Nodo = { id: 'n1', type: 'deal.create', isRoot: false, config: { titulo: 'Venta {{contacto.nombre}}' } };
    const r = await correr([trigger, trato], [{ fromNodeId: 'n0', toNodeId: 'n1', branch: null }]);
    assert.strictEqual(r.steps[1].efectos[0].servicio, 'deals');
    assert.deepStrictEqual(r.steps[1].output, { id: 'sim-deal', title: 'Venta Ana' });
  }

  // --- Las esperas se enseñan y la simulación TERMINA ---------------------------------------
  // Un `wait.delay` de 30 días colgaría la simulación si se esperara de verdad. Y su rareza sale
  // por `efectos`, nunca por un cuarto valor de `status`: uno nuevo saldría crudo en pantalla.
  {
    const espera: Nodo = { id: 'n1', type: 'wait.delay', isRoot: false, config: { minutos: 43200 } };
    const fin: Nodo = { id: 'n2', type: 'message.send', isRoot: false, config: { texto: 'ya pasó' } };
    const r = await correr(
      [trigger, espera, fin],
      [
        { fromNodeId: 'n0', toNodeId: 'n1', branch: null },
        { fromNodeId: 'n1', toNodeId: 'n2', branch: null },
      ],
    );
    assert.strictEqual(r.status, 'done', 'la espera no cuelga la simulación');
    assert.strictEqual(r.steps.length, 3, 'y sigue hasta el final');
    assert.strictEqual(r.steps[1].status, 'ok');
    assert.ok(['ok', 'failed', 'skipped'].includes(r.steps[1].status), 'nunca un cuarto estado');
    assert.strictEqual(r.steps[1].efectos[0].servicio, 'wait');
    assert.strictEqual(r.steps[1].efectos[0].metodo, 'delay');
  }

  // --- `wait.reply`: para, y con la respuesta falsa sigue -----------------------------------
  // Sin sesión en el servidor: la segunda llamada trae la lista entera de respuestas y se
  // rejuega desde cero. Por eso `pendiente` es lo que decide el panel.
  {
    const espera: Nodo = { id: 'n1', type: 'wait.reply', isRoot: false, config: { horas: 24 } };
    const eco: Nodo = { id: 'n2', type: 'message.send', isRoot: false, config: { texto: 'Dijiste {{mensaje.texto}}' } };
    const aristas: Arista[] = [
      { fromNodeId: 'n0', toNodeId: 'n1', branch: null },
      { fromNodeId: 'n1', toNodeId: 'n2', branch: null },
      { fromNodeId: 'n1', toNodeId: 'n2', branch: 'no contestó' },
    ];

    const parada = await correr([trigger, espera, eco], aristas);
    assert.strictEqual(parada.status, 'waiting');
    assert.deepStrictEqual(parada.pendiente, { nodeId: 'n1', tipo: 'wait.reply' });
    assert.strictEqual(parada.steps.length, 2, 'para EN la espera, no después');
    // Tampoco aquí: esperar una respuesta es lo que hace la feature, no un freno.
    assert.strictEqual(parada.steps[1].efectos[0].bloqueado, undefined);

    const sigue = await correr([trigger, espera, eco], aristas, { respuestas: ['sí quiero'] });
    assert.strictEqual(sigue.status, 'done');
    assert.strictEqual(sigue.pendiente, null);
    // La respuesta entra por `mensaje.texto`, igual que la repone `trigger-on-inbound.ts` al
    // reanudar un run de verdad. Si entrara por otro sitio, los comparadores de después verían
    // en seco algo distinto de lo que verán en producción.
    assert.strictEqual(sigue.steps[2].efectos[0].resumen, 'Dijiste sí quiero');
  }

  // --- `null` = no contestó, y encamina por la rama de caducidad ---------------------------
  // Es donde vive el recordatorio y el «se lo paso a una persona»: el camino que nadie prueba
  // nunca. `null` y no una cadena centinela porque una centinela la puede teclear un cliente.
  {
    const espera: Nodo = { id: 'n1', type: 'wait.reply', isRoot: false, config: { horas: 24 } };
    const contesto: Nodo = { id: 'n2', type: 'message.send', isRoot: false, config: { texto: 'gracias' } };
    const nunca: Nodo = { id: 'n3', type: 'message.send', isRoot: false, config: { texto: 'te recuerdo' } };
    const aristas: Arista[] = [
      { fromNodeId: 'n0', toNodeId: 'n1', branch: null },
      { fromNodeId: 'n1', toNodeId: 'n2', branch: null },
      // La rama de caducidad se busca por ESTRUCTURA: es la única con nombre. El nombre exacto
      // da igual a propósito — comparar contra un literal ya dejó una arista muerta una vez.
      { fromNodeId: 'n1', toNodeId: 'n3', branch: 'no contestó' },
    ];

    const callado = await correr([trigger, espera, contesto, nunca], aristas, { respuestas: [null] });
    assert.strictEqual(callado.status, 'done');
    assert.strictEqual(callado.steps[2].nodeId, 'n3', 'sigue por la rama con nombre');
    assert.strictEqual(callado.steps[2].efectos[0].resumen, 'te recuerdo');
    assert.strictEqual(callado.steps[1].efectos[0].bloqueado, undefined, 'hay a dónde seguir');

    // Y contestando va por la otra, con las mismas aristas: es lo que prueba que la rama la
    // elige la respuesta y no el dibujo.
    const hablo = await correr([trigger, espera, contesto, nunca], aristas, { respuestas: ['ya está'] });
    assert.strictEqual(hablo.steps[2].nodeId, 'n2');

    // Sin rama de caducidad, el run REAL se cortaría. Se dice por `bloqueado`, no por un
    // `status` nuevo que la pantalla no sabe pintar.
    const sinRama = await correr([trigger, espera, contesto], aristas.slice(0, 2), { respuestas: [null] });
    assert.strictEqual(sinRama.status, 'done');
    assert.strictEqual(sinRama.steps.length, 2, 'no sigue a ningún sitio');
    assert.ok(sinRama.steps[1].efectos[0].bloqueado?.includes('cortaría'));
  }

  // --- `http.request` no llama, ni con `fetch` roto ----------------------------------------
  {
    const llamada: Nodo = {
      id: 'n1',
      type: 'http.request',
      isRoot: false,
      config: { url: 'https://api.ejemplo.com/{{contacto.waId}}', metodo: 'GET', guardarComo: 'api' },
    };
    const luego: Nodo = { id: 'n2', type: 'message.send', isRoot: false, config: { texto: 'Saldo {{vars.api.json.saldo}}' } };
    const aristas: Arista[] = [
      { fromNodeId: 'n0', toNodeId: 'n1', branch: null },
      { fromNodeId: 'n1', toNodeId: 'n2', branch: null },
    ];

    // Sin respuesta escrita: para y la pide. Que no haya reventado prueba que no llamó.
    const parada = await correr([trigger, llamada, luego], aristas);
    assert.strictEqual(parada.status, 'waiting');
    assert.deepStrictEqual(parada.pendiente, { nodeId: 'n1', tipo: 'http.request' });
    // `bloqueado` NO se usa aquí: que un `http.request` no llame es el funcionamiento normal
    // de la simulación, no un problema. Se dice en `resumen`, y que está parada ya lo dice
    // `pendiente`. El rojo se reserva para lo que en producción habría ido distinto — si tres
    // de cada cuatro rojos son normales, el cuarto deja de leerse.
    assert.strictEqual(parada.steps[1].efectos[0].bloqueado, undefined, 'no llamar no es un freno');
    assert.ok(parada.steps[1].efectos[0].resumen.includes('Escribe qué devolvería'), 'y se dice en el resumen');
    // La URL del efecto va interpolada: es donde se ve que la variable del path resolvió.
    assert.ok(parada.steps[1].efectos[0].resumen.includes('52811'));

    // Con la respuesta escrita, sigue y el resto del flujo la usa.
    const sigue = await correr([trigger, llamada, luego], aristas, {
      httpRespuestas: { n1: { saldo: 42 } },
    });
    assert.strictEqual(sigue.status, 'done');
    assert.strictEqual(sigue.steps[2].efectos[0].resumen, 'Saldo 42');
  }

  // --- El enrutado es el mismo que en producción -------------------------------------------
  // Si la simulación eligiera las ramas por su cuenta, enseñaría un camino que no es el que va a
  // ocurrir, y entonces no sirve para nada.
  {
    const si: Nodo = {
      id: 'n1',
      type: 'logic.condition',
      isRoot: false,
      config: { campo: 'mensaje.texto', operador: 'eq', valor: 'hola' },
    };
    const bueno: Nodo = { id: 'n2', type: 'message.send', isRoot: false, config: { texto: 'por la verdadera' } };
    const malo: Nodo = { id: 'n3', type: 'message.send', isRoot: false, config: { texto: 'por la falsa' } };
    const aristas: Arista[] = [
      { fromNodeId: 'n0', toNodeId: 'n1', branch: null },
      { fromNodeId: 'n1', toNodeId: 'n3', branch: null },
      { fromNodeId: 'n1', toNodeId: 'n2', branch: 'true' },
    ];
    const r = await correr([trigger, si, bueno, malo], aristas);
    assert.strictEqual(r.steps[2].nodeId, 'n2', 'la rama verdadera, y por la arista con nombre');
    assert.strictEqual(r.steps[2].efectos[0].resumen, 'por la verdadera');
  }

  // --- Un ciclo no cuelga -------------------------------------------------------------------
  // El grafo validado es un DAG y el motor lo garantiza además con la unique `(runId, nodeId)`.
  // Aquí lo hace `vistos`, y esto es lo que lo fija: un borrador con un ciclo se puede simular
  // —para eso es en borrador— y tiene que terminar igual.
  {
    const a: Nodo = { id: 'n1', type: 'message.send', isRoot: false, config: { texto: 'vuelta' } };
    const r = await correr(
      [trigger, a],
      [
        { fromNodeId: 'n0', toNodeId: 'n1', branch: null },
        { fromNodeId: 'n1', toNodeId: 'n1', branch: null },
      ],
    );
    assert.strictEqual(r.status, 'done');
    assert.strictEqual(r.steps.length, 2, 'cada nodo se pisa una vez, como en el motor');
  }

  // --- Un handler que revienta deja el run en failed, con el motivo -------------------------
  {
    const roto: Nodo = { id: 'n1', type: 'http.request', isRoot: false, config: { url: 'no-es-una-url' } };
    const r = await correr([trigger, roto], [{ fromNodeId: 'n0', toNodeId: 'n1', branch: null }], {
      permitirHttpReal: true, // deja pasar al handler; falla en la validación, antes del fetch
    });
    assert.strictEqual(r.status, 'failed');
    assert.ok(r.error && r.error.includes('http'), 'el motivo se guarda, no se traga');
    assert.strictEqual(r.steps[1].status, 'failed');
  }

  // --- Un campo que no case con el disparador NO entra -------------------------------------
  // «Se ignora en silencio» solo es aceptable si de verdad se ignora. Un `texto` colado en una
  // automatización de cron armaba un contexto de MENSAJE: la simulación probaba un disparo que
  // no es el que va a ocurrir, y como nadie devuelve un error, el operador se cree la prueba.
  {
    const todo = { texto: 'hola', payload: { a: 1 }, messageId: 'm1' };

    for (const t of ['message.inbound', 'message.keyword']) {
      const e = entradaSegunTrigger(t, todo);
      assert.strictEqual(e.texto, 'hola', t);
      assert.strictEqual(e.messageId, 'm1', t);
      assert.strictEqual(e.payload, null, `${t} no lleva cuerpo de webhook`);
    }

    const web = entradaSegunTrigger('webhook.received', todo);
    assert.deepStrictEqual(web.payload, { a: 1 });
    assert.strictEqual(web.texto, '', 'un texto no entra por una llamada externa');
    assert.strictEqual(web.messageId, null, 'ni se repite un mensaje');

    for (const t of ['schedule.cron', 'manual']) {
      const e = entradaSegunTrigger(t, todo);
      assert.deepStrictEqual(e, { texto: '', payload: null, messageId: null }, t);
    }

    // `null` y `0` son cuerpos válidos de una llamada externa: la puerta es «vino la clave»,
    // no «el valor es verdadero».
    assert.strictEqual(entradaSegunTrigger('webhook.received', { payload: 0 }).payload, 0);
    // Y una cadena vacía no es un texto: se trata como ausente, no como «mensaje en blanco».
    assert.strictEqual(entradaSegunTrigger('message.inbound', { texto: '' }).texto, '');
  }

  // --- La cadena entera se simula, y se ve de quién es cada paso (43) ----------------------
  // Probar solo el padre sin ver lo que hace el hijo es no probar nada. Y sin `deFlujo`, los
  // pasos de los dos se leen como si fueran del mismo grafo.
  {
    const llamada: Nodo = {
      id: 'n1',
      type: 'automation.run',
      isRoot: false,
      config: { automationId: 'b', guardarComo: 'sub', argumentos: [{ nombre: 'quien', ruta: 'contacto.nombre' }] },
    };
    const luego: Nodo = { id: 'n2', type: 'message.send', isRoot: false, config: { texto: 'B dijo {{vars.sub.eco}}' } };
    const aristas: Arista[] = [
      { fromNodeId: 'n0', toNodeId: 'n1', branch: null },
      { fromNodeId: 'n1', toNodeId: 'n2', branch: null },
    ];

    const hijoNodos: Nodo[] = [
      { id: 'b0', type: 'message.inbound', isRoot: true, config: {} },
      { id: 'b1', type: 'var.set', isRoot: false, config: { guardarComo: 'eco', valor: 'hola {{vars.quien}}' } },
    ];
    const subflujos = {
      b: { nombre: 'Bienvenida', status: 'active', nodes: hijoNodos, edges: [{ fromNodeId: 'b0', toNodeId: 'b1', branch: null }] },
    };

    const r = await correr([trigger, llamada, luego], aristas, { subflujos, cadena: ['a'] });
    assert.strictEqual(r.status, 'done');

    // Los pasos del hijo van detrás del que lo llamó, marcados con su flujo.
    const delHijo = r.steps.filter((p) => p.deFlujo?.nombre === 'Bienvenida');
    assert.strictEqual(delHijo.length, 2, 'el trigger del hijo y su nodo');
    assert.ok(r.steps.filter((p) => !p.deFlujo).length >= 3, 'y los del padre siguen sin marca');
    // El id además del nombre: desde un paso del hijo se puede abrir ESE flujo.
    assert.strictEqual(delHijo[0].deFlujo?.automationId, 'b');
    // Y su `tipo`, porque el editor no tiene el grafo del hijo y sin esto la fila sale con el
    // título en blanco. Solo en los pasos del hijo: los del padre los resuelve él.
    assert.deepStrictEqual(delHijo.map((p) => p.tipo), ['message.inbound', 'var.set']);
    assert.ok(r.steps.filter((p) => !p.deFlujo).every((p) => p.tipo === undefined), 'los propios no lo llevan');

    // El `vars` del hijo vuelve al padre a secas, no dentro de un sobre: con el sobre, el dato
    // quedaría en `{{vars.sub.vars.eco}}` y el aplanado del editor no llegaría.
    const envio = r.steps.find((p) => p.nodeId === 'n2' && !p.deFlujo);
    assert.strictEqual(envio?.efectos?.[0]?.resumen, 'B dijo hola Ana', 'y los argumentos llegaron');

    // El sobre sí está en el PASO, para poder entrar al run del hijo desde el cajón.
    const llamado = r.steps.find((p) => p.nodeId === 'n1');
    assert.strictEqual((llamado?.output as { nombre?: string })?.nombre, 'Bienvenida');
  }

  // --- Un sub-flujo que espera aborta también en seco --------------------------------------
  // Si la simulación lo dejara pasar, enseñaría un recorrido que en producción no ocurre.
  {
    const llamada: Nodo = { id: 'n1', type: 'automation.run', isRoot: false, config: { automationId: 'b' } };
    const hijoNodos: Nodo[] = [
      { id: 'b0', type: 'message.inbound', isRoot: true, config: {} },
      { id: 'b1', type: 'wait.reply', isRoot: false, config: { horas: 24 } },
    ];
    const r = await correr([trigger, llamada], [{ fromNodeId: 'n0', toNodeId: 'n1', branch: null }], {
      subflujos: { b: { nombre: 'Encuesta', status: 'active', nodes: hijoNodos, edges: [{ fromNodeId: 'b0', toNodeId: 'b1', branch: null }] } },
      cadena: ['a'],
    });
    assert.strictEqual(r.status, 'failed');
    assert.ok(r.error?.includes('no puede esperar') || r.error?.includes('Encuesta'), r.error ?? '');
  }

  // --- Un bucle de llamadas se corta también en seco ----------------------------------------
  {
    const llamada: Nodo = { id: 'n1', type: 'automation.run', isRoot: false, config: { automationId: 'a' } };
    const r = await correr([trigger, llamada], [{ fromNodeId: 'n0', toNodeId: 'n1', branch: null }], {
      subflujos: { a: { nombre: 'Yo misma', status: 'active', nodes: [trigger], edges: [] } },
      cadena: ['a'],
    });
    assert.strictEqual(r.status, 'failed');
    assert.ok(r.error?.includes('bucle'), r.error ?? '');
  }

  // --- Los dobles devuelven la forma que los handlers LEEN ----------------------------------
  // `message.send` lee `msg?.wamid` y `addNote` lee `nota?.id`. Un doble que devolviera
  // `undefined` haría que el contexto final de la simulación no se pareciera al de producción,
  // y el contexto final es justo lo que se mira para entender qué pasó.
  {
    const registro: Parameters<typeof dobles>[0] = [];
    const s = dobles(registro, null);
    const msg = await s.messaging.send('t1', 'c1', { type: 'text', text: 'x' });
    assert.ok(msg.wamid, 'send devuelve algo con wamid');
    const nota = await s.conversations.addNote('t1', 'c1', 'u1', 'admin', 'ojo');
    assert.ok(nota.id, 'addNote devuelve algo con id');
    assert.strictEqual(registro.length, 2, 'y las dos llamadas quedaron registradas');
  }

}

main().then(
  () => console.log('simulacion.check.ts OK'),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
