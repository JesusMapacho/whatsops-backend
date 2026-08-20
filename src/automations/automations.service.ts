// CRUD del orquestador (v3 features 17-18): guardar el grafo, activarlo y dispararlo a mano.
//
// Guardar y activar son cosas distintas a propósito: `draft` acepta cualquier cosa (a medio
// dibujar el grafo está roto por definición) y `active` exige que el grafo se pueda recorrer.
// El interruptor es la frontera, no el editor.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { catalogoPublico, nodeType, validarConfig, validarTrigger } from './catalog';
import { problemasDelGrafo } from './graph';
import { patronCron } from './triggers';
import { NOMBRE_VAR } from './contexto';
import { AUTOMATION_QUEUE } from './automations.queue';
import { nuevoTokenDeHook, urlDelHook } from './hooks';

const AUTOMATION_INCLUDE = {
  nodes: { orderBy: { createdAt: 'asc' } },
  edges: true,
} as const;

@Injectable()
export class AutomationsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(AUTOMATION_QUEUE) private readonly cola: Queue,
  ) {}

  catalogo() {
    return catalogoPublico();
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
   * navegador en cada listado por el simple hecho de existir la columna — estos dos métodos
   * devolvían la fila de Prisma entera.
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
    return this.prisma.automation.create({
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

    return this.prisma.automation.update({
      where: { id: a.id },
      data,
      include: AUTOMATION_INCLUDE,
    });
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

      return tx.automation.findFirst({ where: { id: automation.id }, include: AUTOMATION_INCLUDE });
    });
  }

  /** Enciende o apaga. Encender valida el grafo y fija quién ejecuta. */
  async setStatus(tenantId: string, id: string, activar: boolean, userId: string) {
    const a = await this.get(tenantId, id);
    if (!activar) {
      await this.quitarCron(a.id);
      return this.prisma.automation.update({
        where: { id: a.id },
        data: { status: 'draft' },
        include: AUTOMATION_INCLUDE,
      });
    }

    const problemas = problemasDelGrafo(a.nodes, a.edges);
    if (problemas.length) throw new BadRequestException(problemas.join(' '));
    // Revalida el trigger guardado: pudo entrar cuando el catálogo tenía otra forma.
    const trigger = validarTrigger(a.trigger);

    const actualizada = await this.prisma.automation.update({
      where: { id: a.id },
      data: { status: 'active', actorUserId: userId, trigger: trigger as any },
      include: AUTOMATION_INCLUDE,
    });
    await this.sincronizarCron(actualizada.id, actualizada.trigger);
    return actualizada;
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
 * Crea el run respetando «un run activo por conversación». Devuelve `null` si ya había uno:
 * lo decide la unique `(tenantId, activeConversationId)` de la base y no un `findFirst`, que
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
        activeConversationId: datos.conversationId,
        context: datos.contexto as any,
      },
    });
  } catch (e: any) {
    if (e?.code === 'P2002') return null;
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
