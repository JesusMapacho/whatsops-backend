// El motor (v3 feature 18): avanza un run por su grafo, nodo a nodo, en un worker.
//
// Nunca inline, por el mismo principio que el webhook: una automatización habla con
// proveedores externos, y eso no puede colgar ni una petición HTTP ni la ingesta de un
// mensaje.
//
// UN NODO POR JOB, no el grafo entero en un job: así el reintento de pg-boss reintenta el
// paso que falló y no todo lo anterior —que ya le mandó mensajes a un cliente—.
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { JobWithMetadata } from 'pg-boss';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { MessagingService } from '../messaging/messaging.service';
import { ConversationsService } from '../messaging/conversations.service';
import { DealsService } from '../crm/deals.service';
import { TasksService } from '../crm/tasks.service';
import { PgBossService } from '../queue/pgboss.service';
import { STANDARD_RETRY } from '../queue/queue-options';
import { Contexto, conSalidaYVariable } from './contexto';
import { ErrorDeSubflujo, Nivel, Persistencia, TOPE_TIEMPO_MS, ejecutarSubflujo, nivelDelHijo } from './subflujo';
import { Salida, Servicios, TIPO_LLAMADA, interpolarConfig, nodeType } from './catalog';
import { MAX_REVIVIDOS, queHacerCon } from './barrido';
import { nodoRaiz, siguienteNodoId } from './graph';
import { patronCron } from './triggers';
import { AUTOMATION_QUEUE, AUTOMATION_CRON_QUEUE, AUTOMATION_SWEEP_QUEUE } from './automations.queue';
import { contextoDeConversacion, crearRun } from './automations.service';

type Arista = { fromNodeId: string; toNodeId: string; branch: string | null };

@Injectable()
export class AutomationsProcessor implements OnModuleInit {
  private readonly logger = new Logger(AutomationsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly messaging: MessagingService,
    private readonly conversations: ConversationsService,
    private readonly deals: DealsService,
    private readonly tasks: TasksService,
    private readonly cola: PgBossService,
  ) {}

  async onModuleInit() {
    // Idempotentes (ON CONFLICT DO NOTHING): no se confía en el orden de inicialización
    // entre providers.
    await this.cola.createQueue(AUTOMATION_QUEUE, STANDARD_RETRY);
    await this.cola.createQueue(AUTOMATION_CRON_QUEUE, STANDARD_RETRY);
    await this.cola.createQueue(AUTOMATION_SWEEP_QUEUE, STANDARD_RETRY);

    await this.cola.workWithMetadata<{ runId: string }>(AUTOMATION_QUEUE, {}, (job) => {
      // ¿Es el último intento? Decide si un fallo mata el run o solo lo deja reintentando.
      const ultimo = (job.retryCount ?? 0) >= (job.retryLimit ?? 0);
      return this.avanzar(job.data.runId, ultimo);
    });
    await this.cola.work<{ automationId: string }>(AUTOMATION_CRON_QUEUE, (job) =>
      this.dispararCron(job.data.automationId),
    );
    await this.cola.work(AUTOMATION_SWEEP_QUEUE, () => this.barrer());
  }

  /**
   * Un tick del barrido: libera lo que se quedó a medias.
   *
   * La DECISIÓN de qué hacer con cada run vive en `barrido.ts`, puro y comprobado: es la parte
   * con bordes (¿a los diez minutos o a los once?, ¿al tercer intento o al cuarto?) y no
   * debería hacer falta una base de datos para probarla. Aquí solo se ejecuta lo que decida.
   *
   * Cada acción con su propio `catch`: un run que no se deja arreglar no puede hacer que el
   * tick entero se marque fallido y se reintente sobre los demás.
   */
  private async barrer() {
    // Solo los vivos. `@@index([tenantId, status])` ya existe y es el que sirve.
    const vivos = await this.prisma.automationRun.findMany({
      where: { status: { in: ['running', 'waiting'] } },
      select: {
        id: true,
        tenantId: true,
        status: true,
        updatedAt: true,
        reanudarEn: true,
        caducaEn: true,
        vecesRevivido: true,
        currentNodeId: true,
        automationId: true,
        parentRunId: true,
      },
      // Tope: si algo se descontroló, mejor barrer 200 por tick que traerse la tabla entera.
      take: 200,
    });

    const ahora = new Date();
    const cuenta = { revividos: 0, cortados: 0, sinRespuesta: 0 };

    for (const run of vivos) {
      const accion = queHacerCon({ ...run, esHijo: run.parentRunId !== null }, ahora);
      if (accion === 'nada') continue;
      try {
        if (accion === 'revivir') {
          await this.revivir(run);
          cuenta.revividos++;
        } else if (accion === 'cortar') {
          await this.cerrar(
            run,
            'cortado',
            `Se cortó la ejecución: el proceso murió o se perdió su trabajo, y no se pudo retomar tras ${MAX_REVIVIDOS} intentos. Ningún paso se repitió.`,
          );
          cuenta.cortados++;
        } else {
          await this.sinRespuesta(run);
          cuenta.sinRespuesta++;
        }
      } catch (e) {
        this.logger.warn(`No se pudo barrer el run ${run.id}: ${(e as Error).message}`);
      }
    }

    // Solo se loguea si hubo algo que corregir: con un tick cada dos minutos, «0 liberados»
    // serían 720 líneas al día. Misma regla que la reconciliación de WAHA.
    if (cuenta.revividos || cuenta.cortados || cuenta.sinRespuesta) {
      this.logger.log(
        `Barrido: ${cuenta.revividos} revividos, ${cuenta.cortados} cortados, ` +
          `${cuenta.sinRespuesta} sin respuesta (de ${vivos.length} vivos).`,
      );
    }
    return cuenta;
  }

  /**
   * Re-encolar es SEGURO: la unique `(runId, nodeId)` hace que un nodo ya `ok` no se repita, así
   * que un mensaje no sale dos veces. Se cuenta el intento para no re-encolar en bucle un run
   * que muere siempre — salvo cuando lo que se perdió fue su job con `delay`, que no es un
   * fallo suyo sino de la cache.
   */
  private async revivir(run: { id: string; status: string; reanudarEn: Date | null }) {
    const jobPerdido = run.status === 'waiting' && !!run.reanudarEn;
    await this.prisma.automationRun.update({
      where: { id: run.id },
      data: {
        status: 'running',
        reanudarEn: null,
        ...(jobPerdido ? {} : { vecesRevivido: { increment: 1 } }),
      },
    });
    await this.cola.send(AUTOMATION_QUEUE, { runId: run.id });
  }

  /**
   * Se le acabó la paciencia esperando que contestaran. Sigue por la rama «no contestó» si el
   * operador cableó algo ahí; si no, se cierra. Cerrar en silencio era lo que dejaba la
   * conversación bloqueada para siempre y sin sitio donde colgar un recordatorio.
   */
  private async sinRespuesta(run: { id: string; tenantId: string; currentNodeId: string | null; automationId: string }) {
    const aristas = await this.prisma.automationEdge.findMany({
      where: { automationId: run.automationId },
      select: { fromNodeId: true, toNodeId: true, branch: true },
    });
    // `currentNodeId` apunta al nodo SIGUIENTE al de la espera (el motor lo adelanta antes de
    // dormirse), así que la rama se busca desde el de la espera: el que tiene la arista.
    const espera = aristas.find((a) => a.toNodeId === run.currentNodeId && a.branch === null);
    // La rama de caducidad se identifica por ESTRUCTURA y no por nombre: `wait.reply` ofrece
    // «contestó» (rama `null`) y la de caducidad, así que la de caducidad es la única con
    // nombre. Antes se comparaba contra un literal que el frontend tenía copiado a mano, y
    // divergir dejaba la arista muerta en silencio. El porqué completo, en `catalog.ts`.
    const salida = espera && aristas.find((a) => a.fromNodeId === espera.fromNodeId && a.branch !== null);

    if (!salida) {
      return this.cerrar(run, 'cortado', 'El contacto no contestó a tiempo, y no hay una rama «no contestó» a donde seguir.');
    }
    await this.prisma.automationRun.update({
      where: { id: run.id },
      data: { status: 'running', currentNodeId: salida.toNodeId, waitingConversationId: null, caducaEn: null },
    });
    await this.cola.send(AUTOMATION_QUEUE, { runId: run.id });
  }

  /** Un tick del cron: crea el run y lo encola como cualquier otro. */
  private async dispararCron(automationId: string) {
    const a = await this.prisma.automation.findUnique({
      where: { id: automationId },
      select: { id: true, tenantId: true, status: true, trigger: true },
    });
    // Pudo borrarse o apagarse entre dos ticks: no hacer nada es la respuesta correcta.
    if (!a || a.status !== 'active') return;
    const run = await crearRun(this.prisma, {
      tenantId: a.tenantId,
      automationId: a.id,
      conversationId: null,
      contexto: await contextoDeConversacion(this.prisma, a.tenantId, null, {
        tipo: 'schedule.cron',
        patron: patronCron(a.trigger),
      }),
    });
    if (run) await this.cola.send(AUTOMATION_QUEUE, { runId: run.id });
  }

  private async avanzar(runId: string, ultimoIntento: boolean) {
    const run = await this.prisma.automationRun.findUnique({
      where: { id: runId },
      include: { automation: { include: { nodes: true, edges: true } } },
    });
    if (!run) return;

    // Un run aparcado por TIEMPO se despierta aquí: lo único que encola un job suyo es su
    // propio `delay` o el barrido reponiéndolo, así que si llega uno, es su despertador. No se
    // compara la hora a propósito — BullMQ despierta con la precisión que tenga, y comparar
    // dejaría al run dormido para siempre por unos milisegundos de adelanto.
    if (run.status === 'waiting' && run.reanudarEn) {
      await this.prisma.automationRun.update({
        where: { id: run.id },
        data: { status: 'running', reanudarEn: null },
      });
      run.status = 'running';
    }

    // Un run que ya terminó —o que espera a que CONTESTE el cliente— no se toca: se llega aquí
    // cuando un job repetido se cuela, y avanzarlo repetiría efectos. Al que espera respuesta
    // lo despierta el entrante (`trigger-on-inbound.ts`), que lo pasa a `running` él mismo.
    if (run.status !== 'running') return;

    const { nodes, edges } = run.automation;
    const nodo = run.currentNodeId ? nodes.find((n) => n.id === run.currentNodeId) : nodoRaiz(nodes);
    if (!nodo) return this.cerrar(run, 'done');

    const contextoPrevio = run.context as Contexto;
    const tipo = nodeType(nodo.type);

    // Los triggers no se ejecutan: son la condición de nacimiento del run, no un paso. Pero
    // SÍ tienen salida —la carga que trajo el disparo, ya en el contexto—, y por eso pasan
    // por `conSalidaYVariable` como cualquier acción: un «Guardar el resultado como» en el
    // nodo de inicio no es un caso especial en ninguna parte del motor.
    if (!tipo?.handler) {
      const carga = (contextoPrevio.disparador ?? null) as unknown;
      await this.registrarPaso(run, nodo.id, 'skipped', null, carga, null);
      return this.continuar(run, edges, nodo.id, null, conSalidaYVariable(contextoPrevio, nodo, carga));
    }

    // IDEMPOTENCIA: si este nodo ya salió bien, el job es un reintento de algo posterior.
    // No se vuelve a ejecutar —eso sería mandar el mensaje dos veces—, se sigue con su
    // salida de entonces.
    const previo = await this.prisma.automationRunStep.findUnique({
      where: { runId_nodeId: { runId: run.id, nodeId: nodo.id } },
    });
    if (previo?.status === 'ok') {
      this.logger.warn(`Paso ya ejecutado ${run.id}/${nodo.id}: se reutiliza su salida.`);
      // La rama sale de la salida que se guardó (los nodos de lógica la escriben ahí): si se
      // reencaminara por la salida por defecto, un reintento podría irse por la rama
      // equivocada, que en este motor significa mandarle otra cosa a un cliente.
      const rama = (previo.output as { rama?: string | null } | null)?.rama ?? null;
      return this.continuar(run, edges, nodo.id, rama, conSalidaYVariable(contextoPrevio, nodo, previo.output ?? null, tipo.variableDe?.(previo.output ?? null)));
    }

    let salida: Salida;
    try {
      // La config llega al handler con las `{{...}}` YA resueltas. En un solo sitio y no en
      // cada handler: cuando era decisión de cada uno, once campos se la saltaban en
      // silencio (el `valor` de «Si… entonces», entre ellos).
      const contextoNodo = { ...contextoPrevio, ajustes: await this.ajustes(run.tenantId) };
      salida = await tipo.handler(interpolarConfig(tipo, nodo.config, contextoNodo), {
        tenantId: run.tenantId,
        // Sin esto el hijo nacía con `parentNodeId: ''` (43): la unique degeneraba —dos nodos
        // de llamada en el MISMO padre chocaban entre sí— y la evidencia «vino de este nodo»
        // salía en blanco. Por eso `nodeId` dejó de ser opcional en `Ejecucion`.
        nodeId: nodo.id,
        actorUserId: run.automation.actorUserId,
        conversationId: run.conversationId,
        // Los ajustes se mezclan arriba y NO se persisten en `AutomationRun.context`: se
        // leen frescos en cada paso, así cambiar un precio en la pantalla alcanza también a
        // los runs que ya están a mitad de camino. Y es un solo sitio, en vez de los tres
        // que crean runs (crearRun, dispararCron y el entrante).
        contexto: contextoNodo,
        servicios: this.servicios(run, { profundidad: 0, cadena: [run.automationId], presupuesto: { subRuns: 0, nodos: 0, hastaMs: Date.now() + TOPE_TIEMPO_MS } }),
      });
    } catch (e) {
      const error = (e as Error)?.message ?? 'Error desconocido';
      await this.registrarPaso(run, nodo.id, 'failed', nodo.config, null, error);
      if (ultimoIntento) {
        // Agotados los reintentos, el run muere con el motivo escrito. Antes NO: dejarlo en
        // `failed` en el primer fallo haría que el reintento de BullMQ se encontrara un run
        // que ya no está `running` y se fuera sin hacer nada.
        await this.cerrar(run, 'failed', error);
      }
      throw e;
    }

    await this.registrarPaso(run, nodo.id, 'ok', nodo.config, salida.output ?? null, null);
    const contexto = conSalidaYVariable(contextoPrevio, nodo, salida.output ?? null, tipo.variableDe?.(salida.output ?? null));

    // Espera por RESPUESTA: el run se aparca y lo reanuda el próximo entrante de esa
    // conversación (`trigger-on-inbound.ts`).
    //
    // AQUÍ, y solo aquí, se toma el candado: `waitingConversationId` significa «este run se
    // queda con la próxima respuesta de esta conversación». Mientras un run corre no lo tiene,
    // que es lo que permite que dos flujos convivan y lo que arregla el agujero por el que un
    // mensaje llegado durante un «Esperar N minutos» no disparaba nada.
    if (salida.esperar?.entrada) {
      await this.prisma.automationRun.update({
        where: { id: run.id },
        data: {
          status: 'waiting',
          waitingConversationId: run.conversationId,
          caducaEn: new Date(Date.now() + (salida.esperar.caducaMs ?? 0)),
          currentNodeId: siguienteNodoId(edges, nodo.id, null),
          context: contexto as any,
        },
      });
      this.emitir(run.tenantId, run.id, 'waiting');
      return;
    }

    return this.continuar(run, edges, nodo.id, salida.branch ?? null, contexto, salida.esperar?.ms);
  }

  private async continuar(
    run: { id: string; tenantId: string },
    edges: Arista[],
    desdeId: string,
    rama: string | null,
    contexto: Contexto,
    esperaMs?: number,
  ) {
    const siguiente = siguienteNodoId(edges, desdeId, rama);
    if (!siguiente) return this.cerrar(run, 'done', undefined, contexto);

    // Una espera por TIEMPO deja el run en `waiting` y no en `running`. Antes se quedaba
    // `running` con la espera solo en el `delay` de Redis, y eso tenía dos consecuencias malas:
    // el barrido no podía distinguirlo de un zombi, y un mensaje que llegara durante la espera
    // no disparaba nada (ni reanudaba, porque la query exige `waiting`, ni creaba run nuevo,
    // porque chocaba con el candado) y no dejaba rastro.
    await this.prisma.automationRun.update({
      where: { id: run.id },
      data: {
        currentNodeId: siguiente,
        context: contexto as any,
        ...(esperaMs ? { status: 'waiting' as const, reanudarEn: new Date(Date.now() + esperaMs) } : {}),
      },
    });
    // Re-encolar en vez de seguir en el mismo job: cada nodo con su propio reintento, y una
    // espera larga no ocupa un worker.
    //
    // Si este `add` falla, NO se cierra el run aquí: el `throw` deja que BullMQ reintente el
    // job entero (la idempotencia por `(runId, nodeId)` hace que no repita efectos), y si se
    // agotan los intentos lo recoge el barrido — `running` sin señal, o `waiting` con su hora
    // pasada. Cerrarlo en el primer fallo es la trampa que el `catch` del handler ya documenta:
    // el reintento se encontraría un run que ya no está `running` y se iría sin hacer nada.
    // El barrido ES la compensación, y por eso aquí no hace falta el remiendo que lleva el hook.
    await this.cola.send(
      AUTOMATION_QUEUE,
      { runId: run.id },
      esperaMs ? { startAfter: new Date(Date.now() + esperaMs) } : undefined,
    );
  }

  /**
   * `cortado` = acabó sin terminar y NO porque un nodo fallara: caducó la espera, lo canceló
   * una persona, o murió el proceso y el barrido se rindió. Distinguirlo de `failed` importa
   * porque un tope alcanzado o un cliente que no contesta no son bugs, y mezclarlos manda a
   * alguien a buscar un error que no existe.
   */
  async cerrar(
    run: { id: string; tenantId: string },
    status: 'done' | 'failed' | 'cortado',
    error?: string,
    contexto?: Contexto,
  ) {
    await this.prisma.automationRun.update({
      where: { id: run.id },
      data: {
        status,
        currentNodeId: null,
        // A null para que la unique libere la próxima respuesta de esa conversación, y para que
        // el barrido no vuelva a mirar un run terminado.
        waitingConversationId: null,
        reanudarEn: null,
        caducaEn: null,
        ...(error ? { error } : {}),
        ...(contexto ? { context: contexto as any } : {}),
      },
    });
    // Los hijos vivos se van con el padre. Un sub-run abortado se deja `running` a propósito
    // —para que un reintento del padre lo reanude— pero si el padre termina de verdad, ese
    // «a propósito» se convierte en un run colgado que el barrido ya no va a revivir.
    await this.prisma.automationRun.updateMany({
      where: { parentRunId: run.id, status: { in: ['running', 'waiting'] } },
      data: { status: 'cortado', error: 'El flujo que lo llamó terminó antes.', currentNodeId: null, waitingConversationId: null },
    });
    this.emitir(run.tenantId, run.id, status);
  }

  /**
   * Escribe el paso. `upsert` y no `create`: un reintento del MISMO nodo tras un fallo
   * reescribe su fila en vez de chocar con la unique `(runId, nodeId)` — esa unique existe
   * para saber qué nodos ya se ejecutaron, no para impedir volver a intentar el que falló.
   */
  private async registrarPaso(
    run: { id: string; tenantId: string },
    nodeId: string,
    status: 'ok' | 'failed' | 'skipped',
    input: unknown,
    output: unknown,
    error: string | null,
  ) {
    const datos = {
      status,
      input: (input ?? undefined) as any,
      output: (output ?? undefined) as any,
      error,
    };
    await this.prisma.automationRunStep.upsert({
      where: { runId_nodeId: { runId: run.id, nodeId } },
      create: { tenantId: run.tenantId, runId: run.id, nodeId, ...datos },
      update: datos,
    });
  }

  /**
   * Guarda la salida del nodo en el contexto: siempre bajo `nodos.<id>`, y además bajo
   * `vars.<nombre>` si el operador le puso uno. Lo usan los DOS caminos —el normal y el
   * idempotente— a propósito: si el reintento no repusiera la variable, los nodos siguientes
   * la encontrarían vacía y seguirían adelante sin decir nada.
   */

  /** Las constantes del negocio, como `{{ajustes.precio_kg}}`. */
  private async ajustes(tenantId: string): Promise<Record<string, string>> {
    const filas = await this.prisma.tenantVariable.findMany({
      where: { tenantId },
      select: { name: true, value: true },
    });
    return Object.fromEntries(filas.map((f) => [f.name, f.value]));
  }

  /**
   * Los servicios que ve un nodo. `flujos` es una CLAUSURA sobre el nivel: cada sub-flujo
   * construye para sus propios nodos un `Servicios` con un nivel más, así que la profundidad y
   * la cadena de llamadas viajan en la pila en vez de consultarse — el árbol entero vive dentro
   * de un job, y esa invariante la sostiene el barrido, que nunca revive a un hijo suelto.
   *
   * `presupuesto` es UN objeto compartido por todo el árbol, no uno por padre: por padre los
   * topes se multiplicarían por nivel.
   */
  private servicios(run: { id: string; tenantId: string; conversationId: string | null }, nivel: Nivel): Servicios {
    return {
      messaging: this.messaging,
      conversations: this.conversations,
      deals: this.deals,
      tasks: this.tasks,
      flujos: {
        ejecutar: async (automationId, ej, argumentos) => {
          const flujo = await this.prisma.automation.findFirst({
            // El alcance en el `where` y no en un `if` posterior: un sub-flujo es la superficie
            // perfecta para un cruce de tenants si el id viniera del cliente.
            where: { id: automationId, tenantId: run.tenantId },
            include: { nodes: true, edges: true },
          });
          if (!flujo) {
            throw new ErrorDeSubflujo('El flujo que este nodo quiere ejecutar ya no existe.');
          }
          return ejecutarSubflujo({
            flujo: {
              id: flujo.id,
              nombre: flujo.name,
              status: flujo.status,
              actorUserId: flujo.actorUserId,
              nodes: flujo.nodes,
              edges: flujo.edges,
            },
            tenantId: run.tenantId,
            // El del PADRE, nunca el de la automatización hija: llamar a un flujo no puede ser
            // una forma de hacer lo que el actor no podría hacer directamente.
            actorUserId: ej.actorUserId,
            conversationId: run.conversationId,
            parentRunId: run.id,
            parentNodeId: ej.nodeId ?? '',
            // Lo que hereda: la conversación y quién escribe. Lo que NO hereda: las `vars` del
            // padre. Un sub-flujo cuya conducta dependiera de quién lo llama no es un
            // procedimiento — su interfaz son sus `argumentos` y nada más.
            contexto: {
              mensaje: ej.contexto.mensaje ?? { texto: '', wamid: null },
              contacto: ej.contexto.contacto ?? { id: null, nombre: null, waId: null },
              conversacion: ej.contexto.conversacion ?? { id: run.conversationId },
              disparador: { tipo: TIPO_LLAMADA, desdeRunId: run.id, desdeNodeId: ej.nodeId ?? null },
              nodos: {},
              vars: argumentos,
            },
            ajustes: await this.ajustes(run.tenantId),
            // El nivel de QUIEN LLAMA, sin tocar. `problemaAntesDeLlamar` es quien suma el uno
            // (`cadena.includes(flujo.id)`, `profundidad + 1 > MAX`), así que adelantárselo aquí
            // hacía que el hijo se encontrara a sí mismo en la cadena y **toda primera llamada**
            // muriera con «ya está en la cadena de llamadas». Es el contrato que afirma
            // `subflujo.check.ts` con su `cadena: ['padre']` — solo los antepasados.
            nivel,
            serviciosPara: (hijoId) =>
              this.servicios(
                { id: hijoId, tenantId: run.tenantId, conversationId: run.conversationId },
                nivelDelHijo(nivel, automationId),
              ),
            persistencia: this.persistenciaDeSubflujo(),
            ahora: () => Date.now(),
          });
        },
      },
    };
  }

  /** La base del hijo, por fuera de `subflujo.ts` para que su check corra sin Postgres. */
  private persistenciaDeSubflujo(): Persistencia {
    return {
      crearOReanudar: async (d) => {
        // Ya existe = un reintento del padre. Se devuelve tal cual y el recorrido lo REANUDA:
        // es lo que la unique `(parentRunId, parentNodeId)` existe para dar.
        const previo = await this.prisma.automationRun.findUnique({
          where: { parentRunId_parentNodeId: { parentRunId: d.parentRunId, parentNodeId: d.parentNodeId } },
        });
        if (previo) {
          return {
            id: previo.id,
            status: previo.status,
            currentNodeId: previo.currentNodeId,
            context: (previo.context ?? {}) as Contexto,
          };
        }
        const fila = await this.prisma.automationRun.create({
          data: {
            tenantId: d.tenantId,
            automationId: d.automationId,
            conversationId: d.conversationId,
            parentRunId: d.parentRunId,
            parentNodeId: d.parentNodeId,
            context: d.contexto as any,
          },
        });
        return { id: fila.id, status: fila.status, currentNodeId: fila.currentNodeId, context: d.contexto };
      },
      pasoPrevio: async (runId, nodeId) => {
        const p = await this.prisma.automationRunStep.findUnique({ where: { runId_nodeId: { runId, nodeId } } });
        return p ? { status: p.status, output: p.output } : null;
      },
      registrarPaso: async (runId, nodeId, status, input, output, error) => {
        const run = await this.prisma.automationRun.findUnique({ where: { id: runId }, select: { tenantId: true } });
        if (!run) return;
        await this.prisma.automationRunStep.upsert({
          where: { runId_nodeId: { runId, nodeId } },
          create: { tenantId: run.tenantId, runId, nodeId, status, input: input as any, output: output as any, error },
          update: { status, input: input as any, output: output as any, error },
        });
      },
      avanzarPuntero: async (runId, nodeId, contexto) => {
        await this.prisma.automationRun.update({
          where: { id: runId },
          data: { currentNodeId: nodeId, context: contexto as any },
        });
      },
      cerrar: async (runId, status, error, contexto) => {
        await this.prisma.automationRun.update({
          where: { id: runId },
          data: { status, error, currentNodeId: null, context: contexto as any },
        });
      },
    };
  }

  private emitir(tenantId: string, runId: string, status: string) {
    this.events.emitToTenant(tenantId, 'automation:run', { runId, status });
  }
}
