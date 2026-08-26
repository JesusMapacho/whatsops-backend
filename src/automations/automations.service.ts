// CRUD del orquestador (v3 features 17-18): guardar el grafo, activarlo y dispararlo a mano.
//
// Guardar y activar son cosas distintas a propósito: `draft` acepta cualquier cosa (a medio
// dibujar el grafo está roto por definición) y `active` exige que el grafo se pueda recorrer.
// El interruptor es la frontera, no el editor.
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { catalogoPublico, interpolarConfig, nodeType, validarConfig, validarTrigger } from './catalog';
import { problemasDelGrafo } from './graph';
import { FlujoConocido, idsLlamados, problemasDeLlamadas } from './llamadas';
import { patronCron } from './triggers';
import { NOMBRE_VAR, contextoDeMensaje } from './contexto';
import { entradaSegunTrigger, simular } from './simulacion';
import { aplanarRespuesta } from './sondeo';
import { assertSafeOutboundUrl } from '../waha/waha.url';
import { channelAdapter } from '../messaging/channels';
import { isWithinWindow } from '../messaging/messaging.util';
import { catalogoDeFunciones, problemasDeFunciones } from './expresiones';
import { AUTOMATION_QUEUE } from './automations.queue';
import { nuevoTokenDeHook, urlDelHook } from './hooks';
import { armar, FilaCubo, parseDias, ventana, zonaValida } from './metricas';

const AUTOMATION_INCLUDE = {
  nodes: { orderBy: { createdAt: 'asc' } },
  edges: true,
} as const;

@Injectable()
export class AutomationsService {
  private readonly logger = new Logger(AutomationsService.name);
  /** Cada cuánto barre. Def. 2 min, como la reconciliación de WAHA. 0 o negativo desactiva. */
  private readonly barridoMs = Number(process.env.AUTOMATION_SWEEP_MS) || 2 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(AUTOMATION_QUEUE) private readonly cola: Queue,
  ) {}

  catalogo() {
    return catalogoPublico();
  }

  funciones() {
    return catalogoDeFunciones();
  }

  // --- Constantes del negocio (`{{ajustes.<name>}}`) ------------------------------------

  variables(tenantId: string) {
    return this.prisma.tenantVariable.findMany({
      where: { tenantId },
      select: { name: true, value: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Reemplaza el juego entero. Es una pantalla con un botón de guardar, no un CRUD fila a
   * fila; el mismo trato que `guardarGrafo` le da al grafo.
   */
  async guardarVariables(tenantId: string, body: unknown) {
    const filas = Array.isArray(body) ? body : (body as { variables?: unknown })?.variables;
    if (!Array.isArray(filas)) throw new BadRequestException('Se esperaba una lista de variables.');

    const limpias: { name: string; value: string }[] = [];
    for (const f of filas) {
      const name = String((f as { name?: unknown })?.name ?? '').trim();
      const value = String((f as { value?: unknown })?.value ?? '');
      if (!name) continue; // una fila en blanco de la pantalla no es un error, se ignora
      if (!NOMBRE_VAR.test(name)) {
        throw new BadRequestException(
          `«${name}» no vale como nombre: solo letras, números y guion bajo, empezando por letra.`,
        );
      }
      if (limpias.some((v) => v.name === name)) throw new BadRequestException(`«${name}» está repetida.`);
      limpias.push({ name, value });
    }

    // En una transacción: si se borra y falla el alta, el negocio se queda sin sus precios y
    // las automatizaciones activas empiezan a mandar importes vacíos.
    await this.prisma.$transaction([
      this.prisma.tenantVariable.deleteMany({
        where: { tenantId, name: { notIn: limpias.map((v) => v.name) } },
      }),
      ...limpias.map((v) =>
        this.prisma.tenantVariable.upsert({
          where: { tenantId_name: { tenantId, name: v.name } },
          create: { tenantId, name: v.name, value: v.value },
          update: { value: v.value },
        }),
      ),
    ]);
    return this.variables(tenantId);
  }

  /**
   * La base pública de la API, para armar la URL de los hooks. Env y no derivado del `Host`
   * de la petición: si no, quien entra por `http://localhost:3000` copia una URL de localhost
   * a un sistema externo. Misma decisión que `WAHA_CALLBACK_URL`. No entra en la lista
   * `REQUIRED` de `env.validation.ts`: rompería el arranque de todo despliegue existente por
   * una función opcional.
   */
  private baseApi(): string {
    return process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  }

  /**
   * Fuera el token crudo, dentro la URL ya armada. Sin este mapeo, `hookToken` viajaría al
   * navegador por el simple hecho de existir la columna — estos métodos devolvían la fila de
   * Prisma entera.
   *
   * Pasa por aquí TODO lo que devuelva una `Automation`, no solo las lecturas: durante un
   * tiempo `create`, `patch`, `guardarGrafo` y `setStatus` devolvieron la fila cruda, así que
   * el token acababa en la memoria del navegador sin que nadie lo hubiera pedido. Un método
   * nuevo que devuelva una automatización y no llame aquí reabre esa fuga.
   */
  private sinToken<T extends { hookToken?: string | null }>(a: T) {
    const { hookToken, ...resto } = a;
    return { ...resto, hookUrl: urlDelHook(this.baseApi(), hookToken) };
  }

  async list(tenantId: string) {
    const filas = await this.prisma.automation.findMany({
      where: { tenantId },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { runs: true, nodes: true } } },
    });
    return filas.map((a) => this.sinToken(a));
  }

  async get(tenantId: string, id: string) {
    const a = await this.prisma.automation.findFirst({
      where: { id, tenantId },
      include: AUTOMATION_INCLUDE,
    });
    if (!a) throw new NotFoundException('Automatización no encontrada');
    return this.sinToken(a);
  }

  /**
   * Rota el token de la URL pública.
   *
   * **NO apaga la automatización**, a diferencia de guardar el grafo o cambiar el disparador:
   * rotar una credencial no cambia lo que la automatización hace. Como en este archivo el
   * patrón es «esto la baja a borrador», la excepción necesita estar escrita o alguien la
   * «arregla». Lo que sí rompe es la integración que estuviera usando la URL vieja.
   */
  async regenerarHook(tenantId: string, id: string) {
    await this.get(tenantId, id);
    const a = await this.prisma.automation.update({
      where: { id },
      data: { hookToken: nuevoTokenDeHook() },
      select: { hookToken: true },
    });
    return { hookUrl: urlDelHook(this.baseApi(), a.hookToken) };
  }

  async create(tenantId: string, body: unknown, userId: string) {
    const src = (body ?? {}) as Record<string, unknown>;
    const name = typeof src.name === 'string' ? src.name.trim() : '';
    if (!name) throw new BadRequestException('Campo requerido: name');
    const creada = await this.prisma.automation.create({
      data: {
        tenantId,
        name,
        trigger: validarTrigger(src.trigger) as any,
        // Siempre, sea cual sea el disparador: cuestan 24 bytes y evitan un paso extra
        // cuando el operador cambia el disparador a webhook desde el editor.
        hookToken: nuevoTokenDeHook(),
        // Quién la crea es quien la ejecutará. Se vuelve a fijar al activar, que es el
        // momento en que alguien se hace responsable de lo que va a mandar sola.
        actorUserId: userId,
      },
      include: AUTOMATION_INCLUDE,
    });
    return this.sinToken(creada);
  }

  /**
   * Renombrar y cambiar el disparador (v3 feature 19: la pantalla lo necesita; antes el
   * trigger solo se podía fijar al crear).
   *
   * Cambiar el disparador **apaga** la automatización, por lo mismo que guardar el grafo:
   * pasar de «cuando digan precio» a «con cualquier mensaje» estando activa empieza a
   * contestarle a todo el mundo en el mismo instante en que alguien toca un desplegable.
   */
  async patch(tenantId: string, id: string, body: unknown) {
    const a = await this.get(tenantId, id);
    const src = (body ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {};

    if (src.name !== undefined) {
      const name = typeof src.name === 'string' ? src.name.trim() : '';
      if (!name) throw new BadRequestException('El nombre no puede quedar vacío');
      data.name = name;
    }
    if (src.trigger !== undefined) {
      data.trigger = validarTrigger(src.trigger) as any;
      if (a.status === 'active') {
        data.status = 'draft';
        await this.quitarCron(a.id);
      }
    }
    if (!Object.keys(data).length) return a;

    const renombrada = await this.prisma.automation.update({
      where: { id: a.id },
      data,
      include: AUTOMATION_INCLUDE,
    });
    return this.sinToken(renombrada);
  }

  /**
   * Reemplaza el grafo entero (nodos + aristas) en una transacción.
   *
   * Entero y no por partes: el editor manda el dibujo completo, y un guardado parcial deja
   * aristas apuntando a nodos que ya no están. Los ids del cliente son provisionales
   * (`tmp-1`), así que se traducen a los reales aquí.
   */
  async guardarGrafo(tenantId: string, id: string, body: unknown) {
    const automation = await this.get(tenantId, id);
    const src = (body ?? {}) as Record<string, unknown>;
    const nodosIn = Array.isArray(src.nodes) ? src.nodes : [];
    const aristasIn = Array.isArray(src.edges) ? src.edges : [];

    const preparados = nodosIn.map((raw) => {
      const n = (raw ?? {}) as Record<string, unknown>;
      const type = typeof n.type === 'string' ? n.type : '';
      if (!nodeType(type)) throw new BadRequestException(`Tipo de nodo desconocido: ${type || '(vacío)'}`);
      return {
        ref: String(n.id ?? ''),
        type,
        config: validarConfig(type, n.config),
        x: Number.isFinite(Number(n.x)) ? Math.trunc(Number(n.x)) : 0,
        y: Number.isFinite(Number(n.y)) ? Math.trunc(Number(n.y)) : 0,
        isRoot: n.isRoot === true,
      };
    });

    return this.prisma.$transaction(async (tx) => {
      // Borrar primero: las aristas caen por cascada con sus nodos.
      await tx.automationNode.deleteMany({ where: { automationId: automation.id } });

      const idPorRef = new Map<string, string>();
      for (const n of preparados) {
        const creado = await tx.automationNode.create({
          data: {
            tenantId,
            automationId: automation.id,
            type: n.type,
            config: n.config as any,
            x: n.x,
            y: n.y,
            isRoot: n.isRoot,
          },
          select: { id: true },
        });
        if (n.ref) idPorRef.set(n.ref, creado.id);
      }

      for (const raw of aristasIn) {
        const e = (raw ?? {}) as Record<string, unknown>;
        const from = idPorRef.get(String(e.fromNodeId ?? ''));
        const to = idPorRef.get(String(e.toNodeId ?? ''));
        if (!from || !to) {
          throw new BadRequestException('Hay una conexión que apunta a un nodo que no se está guardando.');
        }
        await tx.automationEdge.create({
          data: {
            tenantId,
            automationId: automation.id,
            fromNodeId: from,
            toNodeId: to,
            branch: typeof e.branch === 'string' && e.branch ? e.branch : null,
          },
        });
      }

      // Un grafo que cambia deja de estar activo: si no, el cambio empieza a mandarle cosas
      // a clientes reales en el mismo instante en que alguien mueve una caja.
      if (automation.status === 'active') {
        await tx.automation.update({ where: { id: automation.id }, data: { status: 'draft' } });
      }

      const guardada = await tx.automation.findFirst({
        where: { id: automation.id },
        include: AUTOMATION_INCLUDE,
      });
      return guardada ? this.sinToken(guardada) : null;
    });
  }

  /** Enciende o apaga. Encender valida el grafo y fija quién ejecuta. */
  async setStatus(tenantId: string, id: string, activar: boolean, userId: string) {
    const a = await this.get(tenantId, id);
    if (!activar) {
      await this.quitarCron(a.id);
      const apagada = await this.prisma.automation.update({
        where: { id: a.id },
        data: { status: 'draft' },
        include: AUTOMATION_INCLUDE,
      });
      // Quien la llamaba se queda roto: un sub-flujo tiene que estar activo. Se dice DESPUES de
      // apagarla y no antes —no es una puerta, es un aviso— porque impedir apagar algo por lo
      // que otro depende de ello deja al operador sin salida.
      return { ...this.sinToken(apagada), usadaPor: await this.usadaPor(tenantId, a.id) };
    }

    // Las funciones inexistentes se dicen AQUÍ y no en ejecución: un filtro mal escrito es un
    // error de configuración, y el sitio donde se dice un error de configuración es la
    // pantalla donde se configura. En ejecución `aplicar` no lanza —devuelve el valor sin
    // transformar— así que sin esta puerta el operador no se enteraría nunca.
    //
    // Las llamadas a otros flujos van en la misma lista y por el mismo motivo: un bucle
    // `A → B → A` no da error hasta que corre, y para entonces ya mando mensajes.
    const flujos = await this.grafoDeLlamadas(tenantId);
    const problemas = [
      ...problemasDelGrafo(a.nodes, a.edges),
      ...problemasDeFunciones(a.nodes),
      ...problemasDeLlamadas(a.id, idsLlamados(a.nodes), flujos),
    ];
    if (problemas.length) throw new BadRequestException(problemas.join(' '));
    // Revalida el trigger guardado: pudo entrar cuando el catálogo tenía otra forma.
    const trigger = validarTrigger(a.trigger);

    const actualizada = await this.prisma.automation.update({
      where: { id: a.id },
      data: { status: 'active', actorUserId: userId, trigger: trigger as any },
      include: AUTOMATION_INCLUDE,
    });
    await this.sincronizarCron(actualizada.id, actualizada.trigger);
    return this.sinToken(actualizada);
  }

  async remove(tenantId: string, id: string) {
    const a = await this.get(tenantId, id);
    // Se calcula ANTES de borrar: despues ya no hay a quien preguntarle quien la llamaba.
    const usadaPor = await this.usadaPor(tenantId, a.id);
    await this.quitarCron(a.id);
    await this.prisma.automation.delete({ where: { id: a.id } });
    return { ok: true, usadaPor };
  }

  /**
   * El parentesco de un run, con el NOMBRE del padre dentro y no solo su id (43).
   *
   * Con `parentRunId` a secas, la fila del historial tendria que pedir el padre por cada fila
   * solo para escribir «lanzado por X». Es el mismo motivo por el que `todosLosRuns` ya incluye
   * `automation: {id, name}`: la pantalla no puede pagar una peticion por fila para una frase.
   */
  private static readonly PADRE_INCLUDE = {
    parent: { select: { id: true, automationId: true, automation: { select: { name: true } } } },
  } as const;

  private conPadre<T extends { parentRunId: string | null; parentNodeId: string | null; parent?: any }>(run: T) {
    const { parent, ...resto } = run as any;
    return {
      ...resto,
      parent: parent
        ? {
            runId: parent.id,
            nodeId: run.parentNodeId,
            automationId: parent.automationId,
            automationNombre: parent.automation?.name ?? '',
          }
        : null,
    };
  }

  /** Una ejecucion suelta por id. Es lo que permite entrar al run de un hijo desde el cajon. */
  async run(tenantId: string, id: string) {
    const run = await this.prisma.automationRun.findFirst({
      where: { id, tenantId },
      include: {
        automation: { select: { id: true, name: true } },
        steps: { orderBy: { createdAt: 'asc' } },
        ...AutomationsService.PADRE_INCLUDE,
      },
    });
    if (!run) throw new NotFoundException('Ejecución no encontrada');
    return this.conPadre(run);
  }

  /** Historial de ejecución: lo que se mira cuando alguien pregunta qué pasó. */
  async runs(tenantId: string, id: string, limit = 20) {
    await this.get(tenantId, id);
    const filas = await this.prisma.automationRun.findMany({
      where: { tenantId, automationId: id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(Number(limit) || 20, 1), 100),
      include: { steps: { orderBy: { createdAt: 'asc' } }, ...AutomationsService.PADRE_INCLUDE },
    });
    return filas.map((r) => this.conPadre(r));
  }

  /**
   * TODAS las ejecuciones del negocio, con la automatización de cada una. Es la pregunta «¿qué
   * disparó este mensaje?», que hasta ahora no se podía contestar: las ejecuciones solo se
   * veían por automatización, así que con dos activas se miraba la lista vacía de una mientras
   * los runs se acumulaban en la otra, y eso se vive como que la app se rompió sola.
   *
   * `select` de la automatización y NO `include: { automation: true }`: la fila entera lleva
   * `hookToken`, y devolverla es exactamente lo que `sinToken()` existe para evitar.
   */
  async todosLosRuns(tenantId: string, limit = 30) {
    const filas = await this.prisma.automationRun.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(Number(limit) || 30, 1), 100),
      include: {
        automation: { select: { id: true, name: true } },
        steps: { orderBy: { createdAt: 'asc' } },
        ...AutomationsService.PADRE_INCLUDE,
      },
    });
    return filas.map((r) => this.conPadre(r));
  }

  /**
   * Cancelar a mano. Hasta ahora la única forma de desbloquear una conversación que se había
   * quedado con un run colgado era borrar la automatización —con su cascada— o un UPDATE en la
   * base. El barrido cubre lo automático; esto es para cuando alguien no quiere esperarlo.
   */
  async cancelarRun(tenantId: string, id: string) {
    const run = await this.prisma.automationRun.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!run) throw new NotFoundException('Ejecución no encontrada');
    if (run.status !== 'running' && run.status !== 'waiting') {
      throw new BadRequestException('Esa ejecución ya había terminado.');
    }
    // Los hijos van detras. Esto NO pasa por `cerrar()` del processor —hace su propio update—
    // asi que sin esta linea los sub-runs de un run cancelado a mano se quedan colgados, y el
    // barrido ya no los revive (un hijo nunca se revive suelto).
    await this.prisma.automationRun.updateMany({
      where: { parentRunId: run.id, status: { in: ['running', 'waiting'] } },
      data: { status: 'cortado', error: 'Se canceló el flujo que lo llamó.', currentNodeId: null, waitingConversationId: null },
    });
    return this.prisma.automationRun.update({
      where: { id: run.id },
      data: {
        status: 'cortado',
        error: 'Cancelada a mano.',
        currentNodeId: null,
        waitingConversationId: null,
        reanudarEn: null,
        caducaEn: null,
      },
    });
  }

  /**
   * Disparo manual. Sirve para el trigger `manual` y para probar cualquier automatización
   * sin esperar a que escriba un cliente.
   */
  async runManual(tenantId: string, id: string, body: unknown) {
    const a = await this.get(tenantId, id);
    if (a.status !== 'active') throw new BadRequestException('La automatización no está activa.');
    const src = (body ?? {}) as Record<string, unknown>;
    const conversationId = typeof src.conversationId === 'string' && src.conversationId ? src.conversationId : null;

    if (conversationId) {
      const conv = await this.prisma.conversation.findFirst({
        where: { id: conversationId, tenantId },
        select: { id: true },
      });
      if (!conv) throw new NotFoundException('Conversación no encontrada');
    }

    const run = await crearRun(this.prisma, {
      tenantId,
      automationId: a.id,
      conversationId,
      contexto: await contextoDeConversacion(this.prisma, tenantId, conversationId, { tipo: 'manual' }),
    });
    if (!run) throw new BadRequestException('Ya hay una ejecución en curso para esa conversación.');
    await this.cola.add('run', { runId: run.id });
    return run;
  }

  // --- composicion de flujos (feature 43) --------------------------------------------------

  /**
   * El grafo de llamadas del negocio: quien llama a quien, quien espera, y quien esta activa.
   *
   * Una sola consulta que alimenta las tres cosas de la 43 —validar al activar, `/llamables`, y
   * el aviso al desactivar— porque las tres preguntan lo mismo. El alcance va en el `where`,
   * nunca en un `if` posterior: un sub-flujo es la superficie perfecta para un cruce de tenants.
   */
  private async grafoDeLlamadas(tenantId: string): Promise<Map<string, FlujoConocido>> {
    const filas = await this.prisma.automation.findMany({
      where: { tenantId },
      select: { id: true, name: true, status: true, nodes: { select: { type: true, config: true } } },
    });
    return new Map(
      filas.map((f) => [
        f.id,
        {
          nombre: f.name,
          status: f.status,
          llama: idsLlamados(f.nodes),
          // Por el flag del catalogo, que se declara donde se escribe el handler. En EJECUCION
          // se mira `salida.esperar` por estructura, que coge tambien un nodo cuyo autor se
          // olvidara de declararlo; `catalog.check.ts` afirma que los dos coinciden.
          espera: f.nodes.some((n) => nodeType(n.type)?.espera === true),
        },
      ]),
    );
  }

  /**
   * Las automatizaciones que se pueden llamar desde esta, y el MOTIVO de las que no.
   *
   * Devolver tambien las no elegibles es deliberado: esconderlas deja al operador buscando un
   * flujo que esta ahi, sin nada que le diga por que no aparece. Misma decision que
   * `alcanzable: false` en la 47, un nivel mas arriba.
   */
  async llamables(tenantId: string, id: string) {
    await this.get(tenantId, id);
    const flujos = await this.grafoDeLlamadas(tenantId);
    return [...flujos.entries()]
      .filter(([otroId]) => otroId !== id)
      .map(([otroId, f]) => ({
        id: otroId,
        nombre: f.nombre,
        // Se pregunta «que pasaria si esta automatizacion llamara a esa», que es justo lo que el
        // operador esta a punto de hacer al elegirla en el desplegable.
        problema: problemasDeLlamadas(id, [otroId], flujos)[0] ?? null,
      }));
  }

  /** Quien llama a esta automatizacion. Para avisar antes de desactivarla o borrarla. */
  private async usadaPor(tenantId: string, id: string) {
    const flujos = await this.grafoDeLlamadas(tenantId);
    return [...flujos.entries()]
      .filter(([otroId, f]) => otroId !== id && f.llama.includes(id))
      .map(([otroId, f]) => ({ id: otroId, nombre: f.nombre }));
  }

  // --- simulacion en seco (feature 42) ---------------------------------------------------

  /**
   * Recorre el grafo con una entrada inventada y devuelve que HARIA, sin que salga nada.
   *
   * Vive aqui y no en el processor porque no es un run: no hay fila, no hay job y no hay
   * candado. Lo unico que este metodo hace es reunir lo que la simulacion necesita de la base
   * —el grafo, el contexto, los ajustes y el freno de la ventana— y pasarselo a `simular`,
   * que es puro. El argumento entero, en `contrato/42`.
   *
   * Funciona en borrador: `runManual` exige `active` y eso obligaba a activar para probar,
   * que es justo el problema. Tampoco valida el grafo con `problemasDelGrafo`: a medio dibujar
   * esta roto por definicion, y probar el trozo que ya existe es para lo que se simula.
   */
  /**
   * El contexto con el que se prueba una automatizacion: lo comparten la simulacion en seco
   * (42) y el sondeo de APIs (47).
   *
   * Vive en un metodo y no copiado en los dos porque el contrato de las dos features dice lo
   * mismo: «no se inventa una tercera forma de armar contexto». Dos copias son dos formas en
   * cuanto alguien toca una.
   */
  private async contextoDePrueba(
    tenantId: string,
    a: { trigger: unknown },
    src: Record<string, unknown>,
  ): Promise<{ contexto: Record<string, unknown>; conversationId: string | null; tipoTrigger: string }> {
    // La clave es `type`, no `tipo` (`validarTrigger`, catalog.ts:753). Con la equivocada esto
    // caia siempre al 'manual' y la simulacion de una palabra clave decia que la habia
    // disparado otra cosa.
    const tipoTrigger =
      a.trigger && typeof a.trigger === 'object' && typeof (a.trigger as { type?: unknown }).type === 'string'
        ? ((a.trigger as { type: string }).type)
        : 'manual';
    const { texto, payload, messageId } = entradaSegunTrigger(tipoTrigger, src);
    let conversationId =
      typeof src.conversationId === 'string' && src.conversationId ? src.conversationId : null;

    // Repetir un mensaje real. El alcance va en el `where` y no en un `if` posterior: es el
    // sitio donde se pierde el aislamiento, y aqui el id lo escribe quien llama.
    let contexto: Record<string, unknown>;
    if (messageId) {
      const msg = await this.prisma.message.findFirst({
        where: { id: messageId, tenantId },
        include: { conversation: { include: { contact: { select: { id: true, name: true, waId: true } } } } },
      });
      if (!msg) throw new NotFoundException('Mensaje no encontrado');
      conversationId = msg.conversationId;
      const cuerpo = (msg.payload ?? {}) as { text?: { body?: string } };
      contexto = contextoDeMensaje({
        texto: cuerpo.text?.body ?? '',
        wamid: msg.wamid,
        contacto: {
          id: msg.conversation.contact.id,
          nombre: msg.conversation.contact.name,
          waId: msg.conversation.contact.waId,
        },
        conversationId: msg.conversationId,
        tipo: tipoTrigger,
      });
    } else if (texto) {
      // Un mensaje inventado: mismo armador que el entrante de verdad, para que el contexto
      // tenga las mismas claves. Si hay conversacion, se le pega su contacto.
      const conv = conversationId
        ? await this.prisma.conversation.findFirst({
            where: { id: conversationId, tenantId },
            include: { contact: { select: { id: true, name: true, waId: true } } },
          })
        : null;
      contexto = contextoDeMensaje({
        texto,
        contacto: conv ? { id: conv.contact.id, nombre: conv.contact.name, waId: conv.contact.waId } : null,
        conversationId,
        tipo: tipoTrigger,
      });
    } else {
      contexto = await contextoDeConversacion(this.prisma, tenantId, conversationId, {
        tipo: tipoTrigger,
        ...(payload !== null ? { cuerpo: payload } : {}),
      });
    }

    return { contexto, conversationId, tipoTrigger };
  }

  async simularFlujo(tenantId: string, id: string, body: unknown) {
    const a = await this.get(tenantId, id);
    const src = (body ?? {}) as Record<string, unknown>;
    const { contexto, conversationId } = await this.contextoDePrueba(tenantId, a, src);

    const [variables, conv] = await Promise.all([
      this.prisma.tenantVariable.findMany({ where: { tenantId }, select: { name: true, value: true } }),
      conversationId
        ? this.prisma.conversation.findFirst({
            where: { id: conversationId, tenantId },
            select: { platform: true, lastInboundAt: true },
          })
        : Promise.resolve(null),
    ]);

    // El freno de la ventana de 24 h se evalua UNA vez: es una propiedad de la conversacion
    // —cuando escribio el cliente por ultima vez—, no de cada nodo, y solo se reabre con un
    // entrante. Mismo predicado y mismo mensaje que `messaging.service.ts:122`, para que la
    // simulacion no invente un freno distinto del que va a aplicarse de verdad.
    const adapter = conv ? channelAdapter(conv.platform) : null;
    const frenoEnvio =
      adapter && adapter.enforcesWindow && !isWithinWindow(conv!.lastInboundAt)
        ? adapter.windowClosedMessage
        : null;

    // Los grafos de los flujos que este llama, precargados: `simular` es puro y no consulta
    // nada, asi que sin esto un `automation.run` en seco no podria ensenar que hace el hijo — y
    // probar solo el padre sin ver al hijo es no probar nada.
    //
    // Se traen TODOS los del tenant y no solo los alcanzables en un paso: la cadena puede bajar
    // varios niveles, y una consulta por nivel seria una consulta dentro de un bucle.
    const subflujos = Object.fromEntries(
      (
        await this.prisma.automation.findMany({
          where: { tenantId },
          select: { id: true, name: true, status: true, nodes: true, edges: true },
        })
      ).map((f) => [f.id, { nombre: f.name, status: f.status, nodes: f.nodes, edges: f.edges }]),
    );

    return simular({
      nodes: a.nodes,
      edges: a.edges,
      subflujos,
      cadena: [a.id],
      contexto,
      tenantId,
      actorUserId: a.actorUserId,
      conversationId,
      ajustes: Object.fromEntries(variables.map((v) => [v.name, v.value])),
      // `null` sobrevive al filtro a proposito: significa «no contesto» y encamina por la rama
      // de caducidad. Lo que se cae es cualquier otra cosa (numeros, objetos), que solo puede
      // venir de un cliente mal escrito.
      respuestas: Array.isArray(src.respuestas)
        ? src.respuestas.filter((r): r is string | null => typeof r === 'string' || r === null)
        : [],
      httpRespuestas:
        src.httpRespuestas && typeof src.httpRespuestas === 'object'
          ? (src.httpRespuestas as Record<string, unknown>)
          : {},
      permitirHttpReal: src.permitirHttpReal === true,
      frenoEnvio,
    });
  }

  // --- sondeo de APIs (feature 47) --------------------------------------------------------

  /** Lo que se lee del cuerpo. Un sondeo es para reconocer la forma, no para traerse el dato. */
  private static readonly TOPE_CUERPO = 64 * 1024;
  private static readonly TIMEOUT_SONDEO_MS = 10_000;

  /**
   * Llama a la API del nodo UNA vez y devuelve la forma de lo que contesto.
   *
   * Existe porque configurar un «Llamar a una API» es hoy a ciegas: se teclea
   * `{{vars.api.json...}}` adivinando, se activa, y se descubre si acertaste cuando escribe un
   * cliente. Las rutas que salen de aqui alimentan el autocompletado que ya existe.
   *
   * NO crea ninguna fila y no guarda el resultado: se sondea, se eligen campos, se guarda el
   * nodo. Nada que persistir y nada que invalidar.
   */
  async sondear(tenantId: string, id: string, body: unknown) {
    const a = await this.get(tenantId, id);
    const src = (body ?? {}) as Record<string, unknown>;
    const configCruda = (src.config ?? {}) as Record<string, unknown>;

    const guardarComo = typeof configCruda.guardarComo === 'string' ? configCruda.guardarComo.trim() : '';
    if (!guardarComo) {
      // Las rutas van COMPLETAS para que el cliente no concatene el prefijo, y el prefijo sale
      // de aqui. Sin nombre no hay ruta que devolver, y media docena de rutas que no resuelven
      // es peor respuesta que un error que dice que hacer.
      throw new BadRequestException('Ponle nombre al resultado («Guardar el resultado como») antes de sondear.');
    }

    const tipoHttp = nodeType('http.request');
    if (!tipoHttp) throw new BadRequestException('El nodo de llamada a API no esta en el catalogo.');

    const { contexto } = await this.contextoDePrueba(tenantId, a, src);
    const variables = await this.prisma.tenantVariable.findMany({
      where: { tenantId },
      select: { name: true, value: true },
    });
    // Mismo interpolador que el motor, para que la URL que se llama aqui sea EXACTAMENTE la que
    // se llamaria en produccion. Si se resolviera de otra forma, el sondeo probaria otra API.
    const config = interpolarConfig(tipoHttp, configCruda, {
      ...contexto,
      ajustes: Object.fromEntries(variables.map((v) => [v.name, v.value])),
    });

    const prefijo = `vars.${guardarComo}.json`;
    const metodo = config.metodo === 'POST' ? 'POST' : 'GET';
    const fallo = (error: string) => ({ estado: 0, ok: false, rutas: [], error });

    let url: URL;
    try {
      url = await assertSafeOutboundUrl(String(config.url ?? ''));
    } catch (e) {
      return fallo((e as Error).message);
    }

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), AutomationsService.TIMEOUT_SONDEO_MS);
    try {
      const res = await fetch(url, {
        method: metodo,
        signal: ac.signal,
        // Sin seguir redirecciones: un 302 hacia 169.254.169.254 se salta entera la validacion
        // de arriba, y es el clasico.
        redirect: 'manual',
        ...(metodo === 'POST'
          ? { headers: { 'Content-Type': 'application/json' }, body: String(config.cuerpo ?? '') || '{}' }
          : {}),
      });

      if (res.status >= 300 && res.status < 400) {
        return {
          estado: res.status,
          ok: false,
          rutas: [],
          error: 'Esa URL redirige, y el sondeo no sigue redirecciones. Usa la URL final.',
        };
      }

      // ponytail: se lee el cuerpo entero y se recorta despues. Techo: una respuesta enorme pasa
      // por memoria una vez. Camino: leer el stream por trozos y cortar, cuando alguien lo note.
      const crudo = (await res.text()).slice(0, AutomationsService.TOPE_CUERPO);
      let json: unknown;
      let hayJson = false;
      try {
        json = JSON.parse(crudo);
        hayJson = true;
      } catch {
        hayJson = false;
      }

      const ok = res.ok && hayJson;
      if (!ok) {
        // `cuerpo` y no solo `rutas: []`: un sondeo acaba en 401 mucho mas a menudo que en un
        // JSON limpio, y con la lista vacia a secas la pantalla solo puede decir «no
        // encontramos nada», que es mentira cuando la verdad es «tu API contesto 401».
        return {
          estado: res.status,
          ok: false,
          rutas: [],
          cuerpo: crudo.slice(0, 2000),
          ...(hayJson ? { respuesta: json } : {}),
        };
      }

      // 2xx con JSON: aunque no haya nada que nombrar (`{}`), esto es un exito. Colapsarlo con
      // el caso de arriba seria decirle «contesto mal» a una API que funciona.
      const { rutas, truncado } = aplanarRespuesta(json, prefijo);
      return { estado: res.status, ok: true, rutas, ...(truncado ? { truncado } : {}), respuesta: json };
    } catch (e) {
      const err = e as Error;
      return fallo(err.name === 'AbortError' ? 'La API no contesto a tiempo (10 s).' : (err.message ?? 'No se pudo llamar.'));
    } finally {
      clearTimeout(t);
    }
  }

  // --- metricas -------------------------------------------------------------------------

  /**
   * Los numeros de la lista: el sparkline de N dias, los estados terminales y cuando corrio
   * cada flujo por ultima vez.
   *
   * Endpoint aparte y NO un campo mas en `list()`, que es lo que pidio el frontend y esta
   * argumentado en `contrato/45 § Lo que NO cruza la frontera`: la pantalla tiene que pintarse
   * aunque las metricas fallen. Metido en `GET /automations`, un agregado lento o roto se
   * lleva por delante la lista entera.
   *
   * Tres consultas y no una: la lista de flujos hace falta aparte porque uno que nunca corrio
   * no aparece en ninguna de las otras dos y tiene que salir igual, con la serie a ceros.
   */
  async metricas(tenantId: string, diasRaw?: unknown) {
    const dias = parseDias(diasRaw);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    // Una sola zona para los dos lados del calculo: la que corta los cubos en Postgres y la
    // que genera las claves aqui. Ver `zonaValida`.
    const tz = zonaValida(tenant?.timezone);
    const { claves, desde } = ventana(new Date(), dias, tz);

    const [flujos, cubos, ultimas] = await Promise.all([
      this.prisma.automation.findMany({
        where: { tenantId },
        select: { id: true },
        orderBy: { updatedAt: 'desc' }, // el mismo orden que `list()`, para que casen a simple vista
      }),
      // Los cubos, agregados EN POSTGRES. Raw SQL y no `groupBy` de Prisma —al reves que
      // `KpisService`— porque Prisma no sabe agrupar por un dia derivado, y traerse los runs a
      // memoria para cubearlos en JS no tiene tope. El motivo por el que `kpis.service.ts` huyo
      // del SQL crudo era componer un alcance con `OR`; aqui el alcance es un `"tenantId" = $1`
      // literal y no hay nada que pisar. Ademas el resultado esta acotado: flujos x dias x
      // estados, y no una fila por ejecucion.
      //
      // El `AT TIME ZONE 'UTC'` de en medio NO sobra: `createdAt` es `TIMESTAMP(3)` SIN zona y
      // guarda UTC, asi que sin ese primer paso Postgres interpretaria el valor como hora local
      // del servidor y el corte del dia se iria entero.
      this.prisma.$queryRaw<{ automationId: string; dia: string; status: string; n: bigint }[]>(
        Prisma.sql`
          SELECT "automationId",
                 (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date::text AS dia,
                 "status"::text AS status,
                 count(*)::bigint AS n
          FROM "AutomationRun"
          WHERE "tenantId" = ${tenantId} AND "createdAt" >= ${desde}
          GROUP BY 1, 2, 3
        `,
      ),
      // SIN filtro de fecha, a proposito: la pregunta que contesta es «cuando corrio por ultima
      // vez», asi que `null` tiene que querer decir «nunca», no «no en estos siete dias».
      //
      // ponytail: `AutomationRun` no tiene indice por `createdAt` (solo `(tenantId, status)` y
      // `(automationId)`), asi que esto recorre los runs del tenant. Techo: un tenant con
      // cientos de miles de ejecuciones. Camino: `@@index([tenantId, createdAt])`.
      this.prisma.automationRun.groupBy({
        by: ['automationId'],
        where: { tenantId },
        _max: { createdAt: true },
      }),
    ]);

    return {
      dias,
      desde: claves[0],
      flujos: armar(
        flujos.map((a) => a.id),
        cubos.map((c): FilaCubo => ({ ...c, n: Number(c.n) })), // bigint no serializa a JSON
        claves,
        new Map(
          ultimas.flatMap((u) => (u._max.createdAt ? [[u.automationId, u._max.createdAt]] : [])),
        ),
      ),
    };
  }

  // --- cron ---------------------------------------------------------------------------
  //
  // BullMQ ya sabe de patrones cron, así que no hace falta ni un barrido propio ni una
  // librería que parsee la expresión: un job repetible por automatización, con el id de la
  // automatización como `jobId` para que reactivarla no deje dos.

  async sincronizarCron(automationId: string, trigger: unknown) {
    await this.quitarCron(automationId);
    const patron = patronCron(trigger);
    if (!patron) return;
    await this.cola.add(
      'cron',
      { automationId },
      { repeat: { pattern: patron }, jobId: `cron:${automationId}` },
    );
  }

  private async quitarCron(automationId: string) {
    const repetibles = await this.cola.getRepeatableJobs();
    for (const r of repetibles.filter((x) => x.id === `cron:${automationId}`)) {
      await this.cola.removeRepeatableByKey(r.key);
    }
  }

  // --- barrido --------------------------------------------------------------------------
  //
  // Job repetible de BullMQ y NO `setInterval`, por el mismo motivo que la reconciliación de
  // WAHA lo dice en su comentario: `onModuleInit` corre en CADA réplica, así que con dos
  // instancias del backend un `setInterval` doble-dispararía. Aquí eso no es cosmético: dos
  // réplicas liberando el mismo run a la vez es una carrera sobre la unique. El scheduler vive
  // en Redis y encola una sola vez por periodo.

  async programarBarrido() {
    if (this.barridoMs <= 0) return; // 0 o negativo desactiva, como la purga de WAHA
    try {
      await this.cola.add(
        'sweep',
        {},
        {
          repeat: { every: this.barridoMs },
          jobId: 'automation-sweep-tick', // idempotente: reiniciar no acumula schedulers
          // Un tick cada pocos minutos no debe llenar Redis de completados.
          removeOnComplete: 10,
        },
      );
    } catch (e) {
      // Redis caído al arrancar no puede tumbar el boot del backend.
      this.logger.warn(`No se pudo programar el barrido de runs: ${(e as Error).message}`);
    }
  }

  /** Al arrancar: reponer los repetibles de las cron activas (Redis puede haberse vaciado). */
  async reponerCrons() {
    const activas = await this.prisma.automation.findMany({
      where: { status: 'active' },
      select: { id: true, trigger: true },
    });
    for (const a of activas) await this.sincronizarCron(a.id, a.trigger);
  }
}

// --- Funciones libres, compartidas con el worker del webhook -------------------------

/**
 * Crea el run. Ya NO reserva la conversación: desde la feature 41 un run en curso no bloquea
 * nada, así que dos flujos pueden convivir en la misma conversación. Lo único exclusivo es
 * quién se queda con la próxima respuesta, y eso lo toma el motor al aparcarse.
 *
 * Devuelve `null` solo si choca con esa reserva —la unique de la base y no un `findFirst`, que
 * con dos mensajes llegando a la vez es una carrera que se pierde en producción.
 */
export async function crearRun(
  prisma: PrismaService,
  datos: {
    tenantId: string;
    automationId: string;
    conversationId: string | null;
    contexto: Record<string, unknown>;
  },
) {
  try {
    return await prisma.automationRun.create({
      data: {
        tenantId: datos.tenantId,
        automationId: datos.automationId,
        conversationId: datos.conversationId,
        // `waitingConversationId` NO se pone aquí: un run que arranca no bloquea nada. El
        // candado lo toma el motor al aparcarse en «Esperar respuesta», que es el único momento
        // en que hay algo que reservar.
        context: datos.contexto as any,
      },
    });
  } catch (e: any) {
    // Se mira `meta.target` y no solo el código: la tabla tiene más de una unique, y tratar
    // cualquier choque como «ya hay uno esperando» convierte un fallo distinto en un `null`
    // silencioso que el llamante interpreta al revés.
    if (e?.code === 'P2002' && String(e?.meta?.target ?? '').includes('waitingConversationId')) return null;
    throw e;
  }
}

/** Contexto para un run que no nace de un mensaje (manual o cron). */
export async function contextoDeConversacion(
  prisma: PrismaService,
  tenantId: string,
  conversationId: string | null,
  disparador: Record<string, unknown> = { tipo: 'manual' },
): Promise<Record<string, unknown>> {
  if (!conversationId) {
    // `contacto` con las claves a null y no `{}`: así un `ctx.contacto.id` desde el nodo de
    // código da null en las dos ramas y no `undefined` en una sola.
    return {
      mensaje: { texto: '', wamid: null },
      contacto: { id: null, nombre: null, waId: null },
      conversacion: { id: null },
      disparador,
      nodos: {},
      vars: {},
    };
  }
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: { contact: { select: { id: true, name: true, waId: true } } },
  });
  return {
    mensaje: { texto: '', wamid: null },
    contacto: {
      id: conv?.contact.id ?? null,
      nombre: conv?.contact.name ?? null,
      waId: conv?.contact.waId ?? null,
    },
    conversacion: { id: conversationId },
    disparador,
    nodos: {},
    vars: {},
  };
}
