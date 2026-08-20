// El motor (v3 feature 18): avanza un run por su grafo, nodo a nodo, en un worker.
//
// Nunca inline, por el mismo principio que el webhook: una automatización habla con
// proveedores externos, y eso no puede colgar ni una petición HTTP ni la ingesta de un
// mensaje.
//
// UN NODO POR JOB, no el grafo entero en un job: así el reintento de BullMQ reintenta el
// paso que falló y no todo lo anterior —que ya le mandó mensajes a un cliente—.
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { MessagingService } from '../messaging/messaging.service';
import { ConversationsService } from '../messaging/conversations.service';
import { DealsService } from '../crm/deals.service';
import { TasksService } from '../crm/tasks.service';
import { Contexto, conSalida, conVariable } from './contexto';
import { Salida, Servicios, interpolarConfig, nodeType } from './catalog';
import { nodoRaiz, siguienteNodoId } from './graph';
import { patronCron } from './triggers';
import { AUTOMATION_QUEUE } from './automations.queue';
import { contextoDeConversacion, crearRun } from './automations.service';

type Arista = { fromNodeId: string; toNodeId: string; branch: string | null };

@Processor(AUTOMATION_QUEUE)
export class AutomationsProcessor extends WorkerHost {
  private readonly logger = new Logger(AutomationsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly messaging: MessagingService,
    private readonly conversations: ConversationsService,
    private readonly deals: DealsService,
    private readonly tasks: TasksService,
    @InjectQueue(AUTOMATION_QUEUE) private readonly cola: Queue,
  ) {
    super();
  }

  async process(job: Job<{ runId?: string; automationId?: string }>) {
    if (job.name === 'cron') return this.dispararCron(job.data.automationId!);
    if (!job.data.runId) return;
    // ¿Es el último intento? Decide si un fallo mata el run o solo lo deja reintentando.
    const ultimo = (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
    return this.avanzar(job.data.runId, ultimo);
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
    if (run) await this.cola.add('run', { runId: run.id });
  }

  private async avanzar(runId: string, ultimoIntento: boolean) {
    const run = await this.prisma.automationRun.findUnique({
      where: { id: runId },
      include: { automation: { include: { nodes: true, edges: true } } },
    });
    if (!run) return;
    // Un run que ya terminó —o que espera al cliente— no se toca: se llega aquí cuando un
    // job repetido se cuela, y avanzarlo repetiría efectos.
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
      return this.continuar(run, edges, nodo.id, null, this.conSalidaYVariable(contextoPrevio, nodo, carga));
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
      return this.continuar(run, edges, nodo.id, rama, this.conSalidaYVariable(contextoPrevio, nodo, previo.output ?? null));
    }

    let salida: Salida;
    try {
      // La config llega al handler con las `{{...}}` YA resueltas. En un solo sitio y no en
      // cada handler: cuando era decisión de cada uno, once campos se la saltaban en
      // silencio (el `valor` de «Si… entonces», entre ellos).
      const contextoNodo = { ...contextoPrevio, ajustes: await this.ajustes(run.tenantId) };
      salida = await tipo.handler(interpolarConfig(tipo, nodo.config, contextoNodo), {
        tenantId: run.tenantId,
        actorUserId: run.automation.actorUserId,
        conversationId: run.conversationId,
        // Los ajustes se mezclan arriba y NO se persisten en `AutomationRun.context`: se
        // leen frescos en cada paso, así cambiar un precio en la pantalla alcanza también a
        // los runs que ya están a mitad de camino. Y es un solo sitio, en vez de los tres
        // que crean runs (crearRun, dispararCron y el entrante).
        contexto: contextoNodo,
        servicios: this.servicios(),
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
    const contexto = this.conSalidaYVariable(contextoPrevio, nodo, salida.output ?? null);

    // Espera por respuesta: el run se para y lo reanuda el próximo entrante de esa
    // conversación (`trigger-on-inbound.ts`).
    if (salida.esperar?.entrada) {
      await this.prisma.automationRun.update({
        where: { id: run.id },
        data: {
          status: 'waiting',
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

    await this.prisma.automationRun.update({
      where: { id: run.id },
      data: { currentNodeId: siguiente, context: contexto as any },
    });
    // Re-encolar en vez de seguir en el mismo job: cada nodo con su propio reintento, y una
    // espera larga no ocupa un worker.
    await this.cola.add('run', { runId: run.id }, esperaMs ? { delay: esperaMs } : undefined);
  }

  private async cerrar(
    run: { id: string; tenantId: string },
    status: 'done' | 'failed',
    error?: string,
    contexto?: Contexto,
  ) {
    await this.prisma.automationRun.update({
      where: { id: run.id },
      data: {
        status,
        currentNodeId: null,
        // A null para que la unique `(tenantId, activeConversationId)` libere la conversación:
        // el próximo mensaje del cliente tiene que poder disparar otro run.
        activeConversationId: null,
        ...(error ? { error } : {}),
        ...(contexto ? { context: contexto as any } : {}),
      },
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
  private conSalidaYVariable(ctx: Contexto, nodo: { id: string; config: unknown }, output: unknown): Contexto {
    const conNodo = conSalida(ctx, nodo.id, output);
    const nombre = (nodo.config as Record<string, unknown> | null)?.guardarComo;
    return typeof nombre === 'string' && nombre ? conVariable(conNodo, nombre, output) : conNodo;
  }

  /** Las constantes del negocio, como `{{ajustes.precio_kg}}`. */
  private async ajustes(tenantId: string): Promise<Record<string, string>> {
    const filas = await this.prisma.tenantVariable.findMany({
      where: { tenantId },
      select: { name: true, value: true },
    });
    return Object.fromEntries(filas.map((f) => [f.name, f.value]));
  }

  private servicios(): Servicios {
    return {
      messaging: this.messaging,
      conversations: this.conversations,
      deals: this.deals,
      tasks: this.tasks,
    };
  }

  private emitir(tenantId: string, runId: string, status: string) {
    this.events.emitToTenant(tenantId, 'automation:run', { runId, status });
  }
}
