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
import { catalogoPublico, nodeType, validarConfig, validarTrigger } from './catalog';
import { problemasDelGrafo } from './graph';
import { patronCron } from './triggers';
import { NOMBRE_VAR } from './contexto';
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
      return this.sinToken(apagada);
    }

    // Las funciones inexistentes se dicen AQUÍ y no en ejecución: un filtro mal escrito es un
    // error de configuración, y el sitio donde se dice un error de configuración es la
    // pantalla donde se configura. En ejecución `aplicar` no lanza —devuelve el valor sin
    // transformar— así que sin esta puerta el operador no se enteraría nunca.
    const problemas = [...problemasDelGrafo(a.nodes, a.edges), ...problemasDeFunciones(a.nodes)];
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
    await this.quitarCron(a.id);
    await this.prisma.automation.delete({ where: { id: a.id } });
    return { ok: true };
  }

  /** Historial de ejecución: lo que se mira cuando alguien pregunta qué pasó. */
  async runs(tenantId: string, id: string, limit = 20) {
    await this.get(tenantId, id);
    return this.prisma.automationRun.findMany({
      where: { tenantId, automationId: id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(Number(limit) || 20, 1), 100),
      include: { steps: { orderBy: { createdAt: 'asc' } } },
    });
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
    return this.prisma.automationRun.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(Number(limit) || 30, 1), 100),
      include: {
        automation: { select: { id: true, name: true } },
        steps: { orderBy: { createdAt: 'asc' } },
      },
    });
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
