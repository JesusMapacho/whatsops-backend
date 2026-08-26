// 42 — Simulación en seco: recorrer el grafo y contar qué HARÍA, sin que salga nada.
//
// Hasta ahora `runManual` decía en su comentario que servía «para probar cualquier
// automatización sin esperar a que escriba un cliente», pero creaba un run de verdad: el
// mensaje salía, el trato se creaba, la tarea se asignaba. Probar costaba mensajes reales a
// personas reales.
//
// LA COSTURA ES `Servicios` (`catalog.ts:60`). El catálogo solo conoce el tipo estructural,
// nunca la clase real, así que ya estaba escrito contra una interfaz sin saberlo: en seco se
// le pasa un doble que registra la llamada y devuelve una forma plausible. **Un solo punto de
// sustitución**, y los 23 handlers no aprenden que existe un modo simulación.
//
// Y NADA de un flag `dryRun` hilado por handler: es el fallo que `interpolarConfig` ya
// corrigió una vez en este módulo —cuando interpolar era decisión de cada handler, once
// campos se la saltaban en silencio—, pero con consecuencias peores. El que se lo saltara
// mandaría un mensaje real desde una simulación, que es exactamente lo que esto viene a
// impedir. Si un tipo de nodo consigue provocar un efecto externo en seco, esto está mal
// construido, no incompleto.
//
// Puro salvo por los handlers que llama (ver simulacion.check.ts): no toca Prisma, ni la
// cola, ni la red. Lo que necesita de la base se lo dan hecho en `EntradaSimulacion`.
import { Salida, Servicios, interpolarConfig, nodeType } from './catalog';
import { Contexto, VariableVista, conSalidaYVariable } from './contexto';
import { AristaMin, NodoMin, nodoRaiz, siguienteNodoId } from './graph';
import { MAX_PROFUNDIDAD as SUB_MAX_PROFUNDIDAD } from './subflujo';

/** Lo que un nodo HABRÍA hecho. Es la mitad del valor de la feature: `resumen` va ya
 *  interpolado, que es donde se ve que `{{vars.mi campo}}` iba a salir vacío. */
export interface Efecto {
  servicio: string;
  metodo: string;
  resumen: string;
  argumentos: unknown;
  /**
   * Por qué esto en PRODUCCIÓN no habría ido como parece: un envío que la ventana de 24 h
   * habría frenado, un run que se habría cortado. Campo y no prosa dentro de `resumen`,
   * porque como texto solo se puede enseñar y como campo la pantalla lo pinta en rojo.
   *
   * NO es «aquí la simulación hizo algo distinto de un run real»: eso es toda la simulación.
   * Que un `http.request` no llame o que un `wait.reply` pare a pedirte la respuesta es el
   * funcionamiento normal y esperado, va en `resumen`, y el que la simulación esté parada ya
   * lo dice `pendiente`. Si tres de cada cuatro rojos son normales, el cuarto —el único que
   * existe para que la simulación no mienta por optimista— deja de leerse.
   */
  bloqueado?: string;
}

export interface PasoSimulado {
  id: string;
  nodeId: string;
  status: 'ok' | 'failed' | 'skipped';
  /** La config **ya interpolada**, al revés que en un run real, donde se guarda cruda. Es
   *  deliberado y está en `contrato/42`: ver el texto resuelto es para lo que se simula. */
  input: unknown;
  output: unknown;
  error: string | null;
  createdAt: string;
  efectos: Efecto[];
  /** El sub-flujo del que salió este paso, si no es del flujo que se está simulando (43).
   *  Ausente = es de éste. Es lo que hace la cadena legible: probar solo el padre sin ver lo
   *  que hace el hijo es no probar nada. */
  deFlujo?: string;
  /** Qué le pasó a cada `{{...}}` de la config. En pantalla `Hola ` y `Hola` son
   *  indistinguibles: sin esto el operador no puede saber si ahí había una variable. */
  variables: VariableVista[];
}

export interface Simulacion {
  id: 'simulacion';
  simulado: true;
  status: 'done' | 'failed' | 'waiting';
  conversationId: string | null;
  context: Contexto;
  error: string | null;
  createdAt: string;
  steps: PasoSimulado[];
  /** No-nulo exactamente cuando `status === 'waiting'`: paró y espera que le des algo. */
  pendiente: { nodeId: string; tipo: 'wait.reply' | 'http.request' } | null;
}

type NodoConConfig = NodoMin & { config: unknown };

export interface EntradaSimulacion {
  nodes: NodoConConfig[];
  edges: AristaMin[];
  contexto: Contexto;
  tenantId: string;
  actorUserId: string | null;
  conversationId: string | null;
  ajustes: Record<string, string>;
  /**
   * Las respuestas falsas de los `wait.reply`, en orden y consumidas de una en una.
   *
   * `null` = «no contestó», y encamina por la rama de caducidad. Es `null` y no una cadena
   * centinela a propósito: una centinela es texto que un cliente puede teclear, y el día que
   * alguien conteste literalmente eso, el flujo se iría por la rama equivocada sin que nadie
   * entienda por qué. `null` no lo puede teclear nadie.
   */
  respuestas: (string | null)[];
  httpRespuestas: Record<string, unknown>;
  permitirHttpReal: boolean;
  /** Por qué un envío real NO saldría hoy (la ventana de 24 h), o null. Se calcula una vez
   *  fuera: la ventana es una propiedad de la conversación, no de cada nodo. */
  frenoEnvio: string | null;
  /** Los grafos de los flujos llamables, precargados por el servicio: la simulación es pura y
   *  no consulta nada. Sin esto, un `automation.run` en seco no podría enseñar qué hace. */
  subflujos?: Record<string, { nombre: string; status: string; nodes: NodoConConfig[]; edges: AristaMin[] }>;
  /** La cadena de llamadas, para cortar la recursión igual que en producción. */
  cadena?: string[];
}

/**
 * Qué parte de la petición ACEPTA cada disparador.
 *
 * El contrato dice que un campo que no case con el disparador «se ignora en silencio», y
 * ignorar de verdad hay que hacerlo: sin esto, un `texto` colado en una automatización de cron
 * armaba un contexto de MENSAJE, y la simulación probaba un disparo que no es el que va a
 * ocurrir. El operador no protesta —nadie devuelve un error— y se cree la prueba. Lo encontró
 * el check del frontend afirmando «qué no viaja»; aquí se afirma «qué no entra».
 *
 * Puro, y por eso se puede fijar sin base (ver simulacion.check.ts).
 */
export function entradaSegunTrigger(
  tipoTrigger: string,
  src: Record<string, unknown>,
): { texto: string; payload: unknown; messageId: string | null } {
  const cadena = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const esMensaje = tipoTrigger === 'message.inbound' || tipoTrigger === 'message.keyword';
  return {
    texto: esMensaje ? (cadena(src.texto) ?? '') : '',
    // El cuerpo de la llamada externa. `null` y `0` son cuerpos válidos, así que la puerta es
    // «vino la clave», no «el valor es verdadero».
    payload: tipoTrigger === 'webhook.received' ? (src.payload ?? null) : null,
    messageId: esMensaje ? cadena(src.messageId) : null,
  };
}

const TOPE_PASOS = 200;

function corto(v: unknown, max = 120): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s && s.length > max ? `${s.slice(0, max)}…` : (s ?? '');
}

/**
 * Los dobles: registran la llamada con sus argumentos ya interpolados y devuelven la forma
 * que el handler espera leer. Las formas no son adorno — `message.send` lee `msg?.wamid` y
 * `conversation.addNote` lee `nota?.id`, y un doble que devolviera `undefined` haría que el
 * contexto final de la simulación no se pareciera al de producción.
 */
export function dobles(
  registro: Efecto[],
  frenoEnvio: string | null,
  /** Cómo se simula una llamada a otro flujo. Lo inyecta `simular`, que es quien puede
   *  recursar; el doble no sabe hacerlo solo. */
  llamar?: (automationId: string, argumentos: Record<string, unknown>) => Promise<{ vars: Record<string, unknown>; nombre: string }>,
): Servicios {
  const nota = (servicio: string, metodo: string, resumen: string, argumentos: unknown, bloqueado?: string) => {
    registro.push({ servicio, metodo, resumen, argumentos, ...(bloqueado ? { bloqueado } : {}) });
  };
  return {
    messaging: {
      async send(tenantId: string, conversationId: string, body: any) {
        const cuerpo = (body ?? {}) as { text?: string };
        nota('messaging', 'send', corto(cuerpo.text ?? ''), { conversationId, body }, frenoEnvio ?? undefined);
        return { id: 'sim-msg', wamid: 'wamid.SIMULACION' };
      },
      async syncTemplates(tenantId: string) {
        nota('messaging', 'syncTemplates', 'Sincronizaría las plantillas con Meta', { tenantId });
        return { ok: true, count: 0 };
      },
    },
    conversations: {
      async assign(t: string, id: string, target: string | undefined) {
        nota('conversations', 'assign', target ? `Se la asignaría a ${target}` : 'La dejaría sin asignar', { id, target });
        return { id };
      },
      async setStatus(t: string, id: string, status: unknown) {
        nota('conversations', 'setStatus', `La pondría en «${String(status)}»`, { id, status });
        return { id, status };
      },
      async addNote(t: string, id: string, authorId: string, role: string, body: string) {
        nota('conversations', 'addNote', corto(body), { id, body });
        return { id: 'sim-nota' };
      },
    },
    deals: {
      async create(t: string, body: unknown) {
        const titulo = (body as { title?: string } | null)?.title ?? null;
        nota('deals', 'create', `Crearía el trato ${corto(titulo ?? '')}`, body);
        // Devuelve `title` porque el handler lo lee y lo mete en el contexto: un doble que
        // solo trajera el id dejaría `{{vars.<nombre>.title}}` a null en seco y con valor en
        // producción, que es justo la clase de diferencia que hace inútil una simulación.
        return { id: 'sim-deal', title: titulo };
      },
      async patch(t: string, id: string, body: unknown) {
        nota('deals', 'patch', `Movería el trato ${id}`, { id, body });
        return { id };
      },
      async setStatus(t: string, id: string, body: unknown) {
        nota('deals', 'setStatus', `Cambiaría el estado del trato ${id}`, { id, body });
        return { id };
      },
    },
    tasks: {
      async create(t: string, body: unknown) {
        const titulo = (body as { title?: string } | null)?.title ?? '';
        nota('tasks', 'create', `Crearía la tarea ${corto(titulo)}`, body);
        return { id: 'sim-task' };
      },
    },
    flujos: {
      async ejecutar(automationId, ej, argumentos) {
        if (!llamar) throw new Error('No se puede simular una llamada a otro flujo aquí.');
        const r = await llamar(automationId, argumentos);
        nota('flujos', 'ejecutar', `Ejecutaría «${r.nombre}»`, { automationId, argumentos });
        return { runId: 'simulacion', automationId, nombre: r.nombre, status: 'done', vars: r.vars };
      },
    },
  };
}

/**
 * El recorrido. Es el mismo enrutado que producción —`nodoRaiz`, `siguienteNodoId`,
 * `interpolarConfig` y `conSalidaYVariable` son las mismas funciones que llama el worker— y
 * eso es a propósito: si la simulación decidiera las ramas por su cuenta, enseñaría un camino
 * que no es el que va a ocurrir.
 *
 * ponytail: el esqueleto del bucle sí está duplicado con `automations.processor.ts:187`
 * (`avanzar`), porque allí es un nodo por job con estado en Postgres y aquí es un recorrido
 * síncrono en memoria. Techo: si los dos divergen, la simulación miente. Camino: lo que no
 * puede divergir —el enrutado y el nombrado de variables— ya está fuera de los dos, en
 * `graph.ts` y `contexto.ts`; lo que queda aquí es la persistencia, que en seco no existe.
 *
 * Síncrona y acotada, y eso NO viola «el webhook nunca procesa inline»: ese principio protege
 * el camino del webhook (firma → encolar → 200). Esto es una acción de admin sobre un DAG
 * validado, con `TOPE_PASOS` y con `vistos` haciendo a mano lo que en producción hace la
 * unique `(runId, nodeId)`. Termina siempre.
 */
export async function simular(e: EntradaSimulacion): Promise<Simulacion> {
  const steps: PasoSimulado[] = [];
  const vistos = new Set<string>();
  const respuestas = [...e.respuestas];
  const ahora = () => new Date().toISOString();

  let ctx: Contexto = e.contexto;
  let nodo: NodoConConfig | null = nodoRaiz(e.nodes);
  let status: Simulacion['status'] = 'done';
  let error: string | null = null;
  let pendiente: Simulacion['pendiente'] = null;

  const seguir = (desdeId: string, rama: string | null): NodoConConfig | null => {
    const id = siguienteNodoId(e.edges, desdeId, rama);
    return id ? (e.nodes.find((n) => n.id === id) ?? null) : null;
  };

  while (nodo && steps.length < TOPE_PASOS) {
    if (vistos.has(nodo.id)) break;
    vistos.add(nodo.id);
    const actual: NodoConConfig = nodo;
    const tipo = nodeType(actual.type);

    // Los triggers no se ejecutan: son la condición de nacimiento del run, no un paso. Pero
    // sí tienen salida —la carga que trajo el disparo—, igual que en el motor.
    if (!tipo?.handler) {
      const carga = (ctx.disparador ?? null) as unknown;
      steps.push({
        id: `${actual.id}#${steps.length}`,
        nodeId: actual.id,
        status: 'skipped',
        input: null,
        output: carga,
        error: null,
        createdAt: ahora(),
        efectos: [],
        variables: [],
      });
      ctx = conSalidaYVariable(ctx, actual, carga);
      nodo = seguir(actual.id, null);
      continue;
    }

    const contextoNodo = { ...ctx, ajustes: e.ajustes };
    // Los pasos del sub-flujo, que se cuelan en la lista justo detrás del paso que lo llamó:
    // así la cadena se lee de arriba abajo, que es lo único que la hace útil.
    const pasosDelHijo: PasoSimulado[] = [];
    const vistas: VariableVista[] = [];
    const config = interpolarConfig(tipo, actual.config, contextoNodo, vistas);
    // Sin repetidas: la misma ruta escrita dos veces en el mismo nodo es un aviso, no dos.
    const variables = [...new Map(vistas.map((v) => [`${v.ruta}|${v.estado}`, v])).values()];
    const efectos: Efecto[] = [];
    const paso = (estado: PasoSimulado['status'], output: unknown, err: string | null): PasoSimulado => ({
      id: `${actual.id}#${steps.length}`,
      nodeId: actual.id,
      status: estado,
      input: config,
      output,
      error: err,
      createdAt: ahora(),
      efectos,
      variables,
    });

    // `http.request` no pasa por `Servicios`: llama a `fetch` él mismo (`catalog.ts:494`), así
    // que la costura no lo cubre y se intercepta aquí. Con el interruptor apagado —el
    // defecto— usa lo que hayas escrito en el panel; sin nada escrito, para y te lo pide.
    if (actual.type === 'http.request' && !e.permitirHttpReal) {
      const escrita = e.httpRespuestas[actual.id];
      const metodo = String(config.metodo ?? 'GET');
      if (escrita === undefined) {
        efectos.push({
          servicio: 'http',
          metodo,
          resumen: `Llamaría a ${corto(config.url)}. Escribe qué devolvería, o permite la llamada real.`,
          argumentos: config,
        });
        steps.push(paso('ok', null, null));
        pendiente = { nodeId: actual.id, tipo: 'http.request' };
        status = 'waiting';
        break;
      }
      efectos.push({
        servicio: 'http',
        metodo,
        resumen: `Llamaría a ${corto(config.url)}; no se llamó, se usa la respuesta que escribiste`,
        argumentos: config,
      });
      const salidaHttp = { status: 200, json: escrita };
      steps.push(paso('ok', salidaHttp, null));
      ctx = conSalidaYVariable(ctx, actual, salidaHttp);
      nodo = seguir(actual.id, null);
      continue;
    }

    let salida: Salida;
    try {
      salida = await tipo.handler(config, {
        tenantId: e.tenantId,
        actorUserId: e.actorUserId,
        // Un id de conversación falso cuando no hay ninguna: nada toca la base, así que el
        // único efecto es que los nodos que la necesitan se puedan probar igual, en vez de
        // reventar con «este nodo necesita una conversación».
        conversationId: e.conversationId ?? 'conversacion-simulada',
        contexto: contextoNodo,
        servicios: dobles(efectos, e.frenoEnvio, async (automationId, argumentos) => {
          const sub = e.subflujos?.[automationId];
          if (!sub) throw new Error('El flujo que este nodo quiere ejecutar no está disponible.');
          const cadena = e.cadena ?? [];
          // Las mismas dos guardas que en producción, y por el mismo motivo: una simulación que
          // no las respetara enseñaría un recorrido que no puede ocurrir.
          if (cadena.includes(automationId)) throw new Error(`«${sub.nombre}» ya está en la cadena: sería un bucle.`);
          if (cadena.length + 1 > SUB_MAX_PROFUNDIDAD) throw new Error(`La cadena de llamadas pasa de ${SUB_MAX_PROFUNDIDAD} niveles.`);

          const hijo = await simular({
            ...e,
            nodes: sub.nodes,
            edges: sub.edges,
            cadena: [...cadena, automationId],
            // Lo mismo que hereda en producción: la conversación y quién escribe, nunca las
            // `vars` del padre. Su interfaz son sus argumentos.
            contexto: {
              mensaje: ctx.mensaje ?? { texto: '', wamid: null },
              contacto: ctx.contacto ?? { id: null, nombre: null, waId: null },
              conversacion: ctx.conversacion ?? { id: e.conversationId },
              disparador: { tipo: 'automation.run', desdeFlujo: automationId },
              nodos: {},
              vars: argumentos,
            },
          });
          pasosDelHijo.push(...hijo.steps.map((p) => ({ ...p, deFlujo: sub.nombre })));
          // Un sub-flujo que no termina es un fallo, igual que en producción: no hay dónde
          // aparcar una llamada, así que una espera dentro del hijo aborta al padre.
          if (hijo.status !== 'done') {
            throw new Error(
              hijo.error ?? `«${sub.nombre}» no llega al final: un sub-flujo no puede esperar.`,
            );
          }
          return { vars: (hijo.context.vars ?? {}) as Record<string, unknown>, nombre: sub.nombre };
        }),
      });
    } catch (err) {
      error = (err as Error)?.message ?? 'Error desconocido';
      status = 'failed';
      steps.push(paso('failed', null, error));
      steps.push(...pasosDelHijo);
      break;
    }

    // Las esperas no se esperan: se enseñan. Un `wait.delay` de 30 días termina la simulación
    // en vez de colgarla, y lo que tiene de distinto sale por `efectos` y NO por un cuarto
    // valor de `status`, que en la pantalla saldría crudo y pintaría la espera de verde.
    if (salida.esperar?.ms) {
      efectos.push({
        servicio: 'wait',
        metodo: 'delay',
        resumen: `Aquí esperaría ${Math.round(salida.esperar.ms / 60000)} min, y luego seguiría`,
        argumentos: { ms: salida.esperar.ms },
      });
    }

    if (salida.esperar?.entrada) {
      const respuesta = respuestas.shift();
      if (respuesta === undefined) {
        efectos.push({
          servicio: 'wait',
          metodo: 'reply',
          resumen: 'Aquí esperaría la respuesta del contacto. Escribe qué contestaría para seguir.',
          argumentos: { caducaMs: salida.esperar.caducaMs ?? null },
        });
        steps.push(paso('ok', salida.output ?? null, null));
        pendiente = { nodeId: actual.id, tipo: 'wait.reply' };
        status = 'waiting';
        break;
      }
      // `null` = no contestó. Es la rama donde vive el recordatorio y el «se lo paso a una
      // persona», o sea el camino que nadie prueba nunca — justo el que la feature existe
      // para poder probar.
      //
      // La rama de caducidad se identifica por ESTRUCTURA y no por nombre, igual que en
      // `automations.processor.ts` (`sinRespuesta`): `wait.reply` ofrece «contestó» (rama
      // `null`) y la de caducidad, así que la de caducidad es la única con nombre. Comparar
      // contra un literal es lo que ya dejó una arista muerta en silencio una vez.
      if (respuesta === null) {
        const caducidad = e.edges.find((a) => a.fromNodeId === actual.id && a.branch !== null);
        efectos.push({
          servicio: 'wait',
          metodo: 'reply',
          resumen: caducidad
            ? 'No contesta: sigue por la rama «no contestó»'
            : 'No contesta, y no hay rama «no contestó»',
          argumentos: { respuesta: null, caducaMs: salida.esperar.caducaMs ?? null },
          // Sin rama de caducidad, el run REAL no acaba: se corta. Se dice por `bloqueado` y
          // no por un `status: 'cortado'` porque ese valor no existe en la forma que pinta la
          // pantalla, y uno nuevo saldría crudo.
          ...(caducidad ? {} : { bloqueado: 'El run real se cortaría aquí: no hay a dónde seguir.' }),
        });
        steps.push(paso('ok', salida.output ?? null, null));
        ctx = conSalidaYVariable(ctx, actual, salida.output ?? null);
        nodo = caducidad ? (e.nodes.find((n) => n.id === caducidad.toNodeId) ?? null) : null;
        continue;
      }

      efectos.push({
        servicio: 'wait',
        metodo: 'reply',
        resumen: `Esperaría respuesta; sigue con «${corto(respuesta, 60)}»`,
        argumentos: { respuesta },
      });
      steps.push(paso('ok', salida.output ?? null, null));
      // La respuesta entra al contexto igual que la repone `trigger-on-inbound.ts:57` al
      // reanudar un run de verdad: por `mensaje.texto`, que es lo que miran los comparadores
      // de después. Y se sigue por la salida por defecto, como `automations.processor.ts:288`.
      ctx = conSalidaYVariable({ ...ctx, mensaje: { texto: respuesta, wamid: null } }, actual, salida.output ?? null, tipo.variableDe?.(salida.output ?? null));
      nodo = seguir(actual.id, null);
      continue;
    }

    steps.push(paso('ok', salida.output ?? null, null));
    steps.push(...pasosDelHijo);
    ctx = conSalidaYVariable(ctx, actual, salida.output ?? null, tipo.variableDe?.(salida.output ?? null));
    nodo = seguir(actual.id, salida.branch ?? null);
  }

  return {
    id: 'simulacion',
    simulado: true,
    status,
    conversationId: e.conversationId,
    context: ctx,
    error,
    createdAt: ahora(),
    steps,
    pendiente,
  };
}
