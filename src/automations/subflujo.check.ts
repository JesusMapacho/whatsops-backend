// Check del recorrido de un sub-flujo (feature 43).
// Correr: npx ts-node src/automations/subflujo.check.ts
//
// Esto es lo que compra haber escrito un bucle propio en vez de refactorizar `avanzar`: el
// motor encolado no tiene check —no se puede correr sin Postgres ni Redis— y esto sí. Lo que
// hay que atrapar aquí son las cuatro formas de mandar un mensaje dos veces: repetir un paso que
// ya salió bien, rearrancar un hijo en vez de reanudarlo, dejar que un bucle de llamadas corra,
// y que un sub-flujo espere.
import * as assert from 'node:assert';
import { Servicios } from './catalog';
import { Contexto } from './contexto';
import {
  ErrorDeSubflujo,
  MAX_PROFUNDIDAD,
  Nivel,
  Persistencia,
  TOPE_NODOS,
  TOPE_SUBRUNS,
  TOPE_TIEMPO_MS,
  ejecutarSubflujo,
  nivelDelHijo,
  problemaAntesDeLlamar,
} from './subflujo';

// Un sub-flujo no puede llamar a la red. Se rompe `fetch` para todo el archivo, igual que en
// `simulacion.check.ts`.
(global as unknown as { fetch: unknown }).fetch = () => {
  throw new Error('El sub-flujo llamó a la red');
};

type Nodo = { id: string; type: string; isRoot: boolean; config: unknown };
type Arista = { fromNodeId: string; toNodeId: string; branch: string | null };

/** Cuenta lo que se le pide a la base y lo que sale hacia fuera. */
function dobles() {
  const enviados: string[] = [];
  const creados: string[] = [];
  const pasos = new Map<string, { status: string; output: unknown }>();
  const cerrados: { runId: string; status: string }[] = [];
  let contador = 0;

  const persistencia: Persistencia = {
    async crearOReanudar(d) {
      const clave = `${d.parentRunId}#${d.parentNodeId}`;
      creados.push(clave);
      return { id: `hijo-${++contador}`, status: 'running', currentNodeId: null, context: d.contexto };
    },
    async pasoPrevio(runId, nodeId) {
      return pasos.get(`${runId}#${nodeId}`) ?? null;
    },
    async registrarPaso(runId, nodeId, status, _input, output) {
      pasos.set(`${runId}#${nodeId}`, { status, output });
    },
    async avanzarPuntero() {},
    async cerrar(runId, status) {
      cerrados.push({ runId, status });
    },
  };

  const servicios: Servicios = {
    messaging: {
      async send(_t, _c, body: any) {
        enviados.push(String(body?.text ?? ''));
        return { id: 'm', wamid: 'w' };
      },
      async syncTemplates() {
        return {};
      },
    },
    conversations: {
      async assign() {
        return {};
      },
      async setStatus() {
        return {};
      },
      async addNote() {
        return { id: 'n' };
      },
    },
    deals: {
      async create() {
        return { id: 'd' };
      },
      async patch() {
        return { id: 'd' };
      },
      async setStatus() {
        return { id: 'd' };
      },
    },
    tasks: {
      async create() {
        return { id: 't' };
      },
    },
    flujos: {
      async ejecutar() {
        throw new Error('En este check el hijo no llama a nadie más');
      },
    },
  };

  return { persistencia, servicios, enviados, creados, pasos, cerrados };
}

const CTX: Contexto = {
  mensaje: { texto: 'hola', wamid: null },
  contacto: { id: 'k1', nombre: 'Ana', waId: '52811' },
  conversacion: { id: 'c1' },
  disparador: { tipo: 'automation.run' },
  nodos: {},
  vars: {},
};

const nivelBase = (): Nivel => ({
  profundidad: 0,
  cadena: ['padre'],
  presupuesto: { subRuns: 0, nodos: 0, hastaMs: 9_999_999_999_999 },
});

const flujo = (nodes: Nodo[], edges: Arista[], extra: Record<string, unknown> = {}) => ({
  id: 'hijo',
  nombre: 'Bienvenida',
  status: 'active',
  actorUserId: 'u1',
  nodes,
  edges,
  ...extra,
});

const correr = (
  nodes: Nodo[],
  edges: Arista[],
  d: ReturnType<typeof dobles>,
  extra: Record<string, unknown> = {},
  nivel: Nivel = nivelBase(),
  vars: Record<string, unknown> = {},
) =>
  ejecutarSubflujo({
    flujo: flujo(nodes, edges, extra) as any,
    tenantId: 't1',
    actorUserId: 'u1',
    conversationId: 'c1',
    parentRunId: 'run-padre',
    parentNodeId: 'n-llamada',
    contexto: { ...CTX, vars },
    ajustes: {},
    nivel,
    serviciosPara: () => d.servicios,
    persistencia: d.persistencia,
    ahora: () => 1_000,
  });

const trigger: Nodo = { id: 'h0', type: 'message.inbound', isRoot: true, config: {} };
const seguido = (a: string, b: string): Arista => ({ fromNodeId: a, toNodeId: b, branch: null });

async function main() {
  // --- El `vars` del hijo es lo que vuelve al padre --------------------------------------
  {
    const d = dobles();
    const calc: Nodo = {
      id: 'h1',
      type: 'var.set',
      isRoot: false,
      config: { guardarComo: 'total', valor: '42' },
    };
    const r = await correr([trigger, calc], [seguido('h0', 'h1')], d);

    assert.strictEqual(r.status, 'done');
    assert.deepStrictEqual(r.vars, { total: '42' }, 'lo que el padre lee como {{vars.<nombre>.total}}');
    assert.strictEqual(r.nombre, 'Bienvenida');
    assert.deepStrictEqual(d.cerrados, [{ runId: 'hijo-1', status: 'done' }]);
  }

  // --- Los `argumentos` son la interfaz, y el hijo no ve nada más -------------------------
  // Un sub-flujo cuya conducta dependiera de quién lo llama no es un procedimiento.
  {
    const d = dobles();
    const envio: Nodo = { id: 'h1', type: 'message.send', isRoot: false, config: { texto: '{{vars.quien}}/{{vars.secreto}}' } };
    await correr([trigger, envio], [seguido('h0', 'h1')], d, {}, nivelBase(), { quien: 'Ana' });
    assert.deepStrictEqual(d.enviados, ['Ana/'], 'lo que le pasaron sí; lo que no, vacío');
  }

  // --- Un paso que ya salió `ok` NO se repite ---------------------------------------------
  // Es la mitad de la idempotencia. La otra mitad —no rearrancar el hijo— está más abajo.
  {
    const d = dobles();
    const envio: Nodo = { id: 'h1', type: 'message.send', isRoot: false, config: { texto: 'una vez' } };
    d.pasos.set('hijo-1#h1', { status: 'ok', output: { wamid: 'ya' } });
    await correr([trigger, envio], [seguido('h0', 'h1')], d);
    assert.deepStrictEqual(d.enviados, [], 'el mensaje ya había salido: no sale otra vez');
  }

  // --- Un fallo deja el hijo SIN cerrar, para que el reintento lo reanude ------------------
  {
    const d = dobles();
    const roto: Nodo = { id: 'h1', type: 'http.request', isRoot: false, config: { url: 'no-es-url' } };
    await assert.rejects(() => correr([trigger, roto], [seguido('h0', 'h1')], d), ErrorDeSubflujo);
    assert.deepStrictEqual(d.cerrados, [], 'no se cierra: si se cerrara, el reintento rearrancaría desde el principio');
    assert.strictEqual(d.pasos.get('hijo-1#h1')?.status, 'failed', 'pero el paso queda escrito');
  }

  // --- El mensaje del fallo nombra el flujo Y el nodo --------------------------------------
  // «falló algo» no sirve: lo que el operador necesita saber es dónde mirar.
  {
    const d = dobles();
    const roto: Nodo = { id: 'h1', type: 'http.request', isRoot: false, config: { url: 'no-es-url' } };
    await assert.rejects(
      () => correr([trigger, roto], [seguido('h0', 'h1')], d),
      (e: Error) => e.message.includes('Bienvenida') && e.message.includes('Llamar a una API'),
    );
  }

  // --- Un nodo de espera ABORTA, y se detecta por estructura -------------------------------
  // Alcanzable de verdad pese a las guardas de antes: B se edita —lo que la baja a borrador—,
  // se le mete un `wait.reply`, y B se reactiva. La activación de B valida el grafo desde B, y
  // B no sabe quién la llama.
  for (const espera of [
    { id: 'h1', type: 'wait.reply', isRoot: false, config: { horas: 24 } },
    { id: 'h1', type: 'wait.delay', isRoot: false, config: { minutos: 5 } },
  ] as Nodo[]) {
    const d = dobles();
    await assert.rejects(
      () => correr([trigger, espera], [seguido('h0', 'h1')], d),
      (e: Error) => e instanceof ErrorDeSubflujo && e.message.includes('no puede esperar'),
      espera.type,
    );
    assert.deepStrictEqual(d.cerrados, [], `${espera.type}: tampoco se cierra`);
  }

  // --- Un bucle se corta ANTES de tocar la base --------------------------------------------
  // Si la fila se creara primero, un ciclo dejaría basura por cada vuelta y el rechazo sería
  // más caro que el error.
  {
    const d = dobles();
    const nivel = { ...nivelBase(), cadena: ['padre', 'hijo'] };
    await assert.rejects(
      () => correr([trigger], [], d, {}, nivel),
      (e: Error) => e instanceof ErrorDeSubflujo && e.message.includes('bucle'),
    );
    assert.deepStrictEqual(d.creados, [], 'cero filas: el rechazo va antes que la base');
  }

  // --- Los cuatro topes, y ninguno crea fila ------------------------------------------------
  {
    const hondo = { ...nivelBase(), profundidad: MAX_PROFUNDIDAD };
    const d1 = dobles();
    await assert.rejects(
      () => correr([trigger], [], d1, {}, hondo),
      (e: Error) => e.message.includes(`${MAX_PROFUNDIDAD} niveles`),
    );
    assert.deepStrictEqual(d1.creados, []);

    const lleno = { ...nivelBase(), presupuesto: { subRuns: TOPE_SUBRUNS, nodos: 0, hastaMs: 9e12 } };
    const d2 = dobles();
    await assert.rejects(
      () => correr([trigger], [], d2, {}, lleno),
      (e: Error) => e.message.includes(`${TOPE_SUBRUNS} flujos`),
    );
    assert.deepStrictEqual(d2.creados, []);

    // Un borrador no se ejecuta desde otro sitio: es un flujo a medio escribir.
    const d3 = dobles();
    await assert.rejects(
      () => correr([trigger], [], d3, { status: 'draft' }, nivelBase()),
      (e: Error) => e.message.includes('borrador'),
    );
    assert.deepStrictEqual(d3.creados, []);
  }

  // --- El tope de NODOS y el de TIEMPO sí paran a mitad -------------------------------------
  // Éstos no pueden comprobarse antes de empezar: dependen de por dónde va el recorrido.
  {
    const d = dobles();
    const envio: Nodo = { id: 'h1', type: 'message.send', isRoot: false, config: { texto: 'x' } };
    const nivel = { ...nivelBase(), presupuesto: { subRuns: 0, nodos: TOPE_NODOS, hastaMs: 9e12 } };
    await assert.rejects(
      () => correr([trigger, envio], [seguido('h0', 'h1')], d, {}, nivel),
      (e: Error) => e.message.includes(`${TOPE_NODOS} pasos`),
    );

    // Y el del reloj, que es el que evita que el barrido reviva al padre mientras el árbol
    // sigue vivo y acaben dos workers dentro del mismo hijo.
    const d2 = dobles();
    const caducado = { ...nivelBase(), presupuesto: { subRuns: 0, nodos: 0, hastaMs: 999 } };
    await assert.rejects(
      () => correr([trigger, envio], [seguido('h0', 'h1')], d2, {}, caducado),
      (e: Error) => e.message.includes(`${TOPE_TIEMPO_MS / 1000} s`),
    );
    assert.deepStrictEqual(d2.enviados, [], 'y corta antes de mandar nada');
  }

  // --- El enrutado es el mismo que en producción --------------------------------------------
  {
    const d = dobles();
    const si: Nodo = {
      id: 'h1',
      type: 'logic.condition',
      isRoot: false,
      config: { campo: 'vars.plan', operador: 'eq', valor: 'vip' },
    };
    const bueno: Nodo = { id: 'h2', type: 'message.send', isRoot: false, config: { texto: 'vip' } };
    const malo: Nodo = { id: 'h3', type: 'message.send', isRoot: false, config: { texto: 'normal' } };
    const aristas: Arista[] = [seguido('h0', 'h1'), seguido('h1', 'h3'), { fromNodeId: 'h1', toNodeId: 'h2', branch: 'true' }];

    await correr([trigger, si, bueno, malo], aristas, d, {}, nivelBase(), { plan: 'vip' });
    assert.deepStrictEqual(d.enviados, ['vip'], 'la rama la decide el mismo `siguienteNodoId` que el motor');

    const d2 = dobles();
    await correr([trigger, si, bueno, malo], aristas, d2, {}, nivelBase(), { plan: 'otro' });
    assert.deepStrictEqual(d2.enviados, ['normal']);
  }

  // --- El paso guarda la config CRUDA, como el motor y al revés que la simulación -----------
  {
    const d = dobles();
    const envio: Nodo = { id: 'h1', type: 'message.send', isRoot: false, config: { texto: 'Hola {{vars.quien}}' } };
    await correr([trigger, envio], [seguido('h0', 'h1')], d, {}, nivelBase(), { quien: 'Ana' });
    assert.deepStrictEqual(d.enviados, ['Hola Ana'], 'lo que sale sí va interpolado');
    // El historial de un run de verdad se lee igual que el de cualquier otro: config cruda.
    // Sólo la simulación guarda la resuelta, y eso está declarado en `contrato/42 §4b`.
  }

  // --- Los dos niveles no son el mismo, y confundirlos ya rompió la feature entera ---------
  // El bug: el motor le daba a `problemaAntesDeLlamar` el nivel DEL HIJO, así que el hijo se
  // encontraba a sí mismo en la cadena y **toda primera llamada** moría con «bucle». Ningún
  // check lo vio porque el fallo estaba en el cableado del processor, no en este módulo; lo
  // que se puede afirmar desde aquí es la diferencia entre los dos niveles, que es lo que se
  // confundió. Se pilló corriendo `seed43-padre` contra la base el 2026-08-26.
  {
    const delPadre = nivelBase(); // cadena: ['padre'], o sea SOLO los antepasados
    const f = flujo([trigger], []);
    assert.strictEqual(problemaAntesDeLlamar(f, delPadre), null, 'la primera llamada no es un bucle');

    const delHijo = nivelDelHijo(delPadre, f.id);
    assert.deepStrictEqual(delHijo.cadena, ['padre', 'hijo'], 'el del hijo SÍ se lleva a sí mismo');
    assert.strictEqual(delHijo.profundidad, delPadre.profundidad + 1);
    assert.strictEqual(delHijo.presupuesto, delPadre.presupuesto, 'el presupuesto es del árbol, no una copia');
    assert.match(
      String(problemaAntesDeLlamar(f, delHijo)),
      /bucle/,
      'dárselo a la guarda es exactamente el bug: se ve a sí mismo',
    );
  }

  console.log('subflujo.check.ts OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
