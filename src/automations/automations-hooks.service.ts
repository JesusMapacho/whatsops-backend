// El camino público de `POST /hooks/<token>`. Aparte de `AutomationsService` a propósito:
// allí los catorce métodos empiezan por `tenantId` porque ya hay una sesión detrás, y meter
// aquí en medio el único método que se llama SIN sesión invita a que alguien reutilice uno
// creyendo que filtra por tenant.
//
// Toda la decisión —qué token vale, si esta automatización acepta hooks, si el cuerpo cabe,
// qué estado devolver— está en `hooks.ts`, que es puro y está comprobado. Aquí solo queda la
// plomería: buscar la fila, contar en Postgres, crear el run y encolar.
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PgBossService } from '../queue/pgboss.service';
import { parsePhone } from '../messaging/contact-resolve';
import { Contexto, interpolar } from './contexto';
import { leerTrigger } from './triggers';
import { AUTOMATION_QUEUE } from './automations.queue';
import { crearRun } from './automations.service';
import {
  TOPE_POR_MINUTO,
  TOPE_TENANT_POR_MINUTO,
  aceptaHook,
  claveDeVentana,
  cuerpoDemasiadoGrande,
  estadoDe,
  pareceToken,
  segundosRestantes,
} from './hooks';

// Ventanas viejas (minutos ya pasados) se purgan con baja probabilidad en cada llamada: no es
// crítico para la corrección (la clave rota sola por minuto, así que una fila vieja
// simplemente deja de incrementarse) y así se evita un cron dedicado para algo tan barato.
const PURGA_PROBABILIDAD = 0.01;
const PURGA_ANTIGUEDAD_MS = 5 * 60_000;

@Injectable()
export class AutomationsHooksService {
  private readonly logger = new Logger(AutomationsHooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cola: PgBossService,
  ) {}

  /**
   * Verifica → crea el run con el cuerpo dentro → encola → 200. **Nada de trabajo real en la
   * petición**, igual que el webhook de Meta: el `AutomationRun` con su `context` ES la
   * persistencia, y se escribe antes del `add` y antes de contestar.
   *
   * Lo barato antes que lo caro: forma del token y tamaño del cuerpo no tocan la base.
   */
  async recibir(token: string, cuerpo: unknown, bytes: number) {
    if (!pareceToken(token)) throw new NotFoundException('Hook no encontrado');
    if (cuerpoDemasiadoGrande(bytes)) {
      throw new PayloadTooLargeException('El cuerpo es demasiado grande para una automatización.');
    }
    // `undefined` = Express no supo parsearlo (no venía como application/json). Se dice, en
    // vez de arrancar el flujo con `{}` y que el integrador lo descubra tres días después.
    // Un `null` explícito (`JSON.parse('null')`) sí es un cuerpo, y un `{}` de un ping también.
    if (cuerpo === undefined) {
      throw new UnsupportedMediaTypeException('Manda el cuerpo como application/json.');
    }

    const a = await this.prisma.automation.findUnique({
      where: { hookToken: token },
      select: { id: true, tenantId: true, status: true, trigger: true, tenant: { select: { status: true } } },
    });
    const veredicto = aceptaHook(
      a && { status: a.status, trigger: a.trigger, tenantStatus: a.tenant.status },
    );
    if (!veredicto.ok) {
      const estado = estadoDe(veredicto.motivo);
      throw new HttpException(
        estado === 409 ? 'La automatización está en borrador: actívala para que responda.' : 'Hook no encontrado',
        estado,
      );
    }

    const ahora = Date.now();
    const tope = await this.dentroDelTope(a!.id, a!.tenantId, ahora);
    if (!tope) {
      throw new HttpException(
        { message: `Demasiadas llamadas. Espera ${segundosRestantes(ahora)} s.`, retryAfter: segundosRestantes(ahora) },
        429,
      );
    }

    const contexto = await this.contexto(a!.tenantId, a!.trigger, cuerpo);
    const run = await crearRun(this.prisma, {
      tenantId: a!.tenantId,
      automationId: a!.id,
      conversationId: (contexto.conversacion as { id: string | null }).id,
      contexto,
    });
    // `null` = la unique `(tenantId, waitingConversationId)`: ya hay un run APARCADO esperando
    // la respuesta de ese contacto. Se dice con un 409 y no con un 200: un 200 le hace creer al
    // sistema externo que su llamada surtió efecto.
    //
    // Ojo al cambio de la feature 41: antes chocaba con cualquier run vivo en esa conversación
    // y ahora solo con uno que esté esperando respuesta, así que este 409 es bastante más raro.
    if (!run) throw new ConflictException('Ya hay una automatización esperando la respuesta de ese contacto.');

    try {
      await this.cola.send(AUTOMATION_QUEUE, { runId: run.id });
    } catch (e) {
      // Sin esto el run queda `running` sin job. Desde la feature 41 el barrido lo recogería,
      // pero aquí se cierra igual y en el acto: lo provoca un desconocido a voluntad llamando a
      // una URL pública, y dejarle sembrar runs colgados que alguien tiene que barrer es una
      // superficie de abuso, no un descuido.
      await this.prisma.automationRun.update({
        where: { id: run.id },
        data: { status: 'cortado', waitingConversationId: null, error: 'No se pudo encolar el run.' },
      });
      throw e;
    }
    return { received: true, runId: run.id };
  }

  /**
   * Dos cuentas, no una. La de la automatización no basta: la cola es **compartida entre
   * tenants**, así que un tenant con veinte hooks metería 1200 jobs/min y dejaría a los demás
   * sin worker — aislar por `tenantId` en las queries no sirve si se agota el recurso común.
   *
   * El incremento es un solo `INSERT ... ON CONFLICT DO UPDATE` atómico contra Postgres (la
   * misma base que Neon, sin abrir una conexión aparte): dos peticiones concurrentes no pueden
   * pisarse el conteo, la garantía que antes daba `INCR` de Redis.
   * **Fail-open** si la base no contesta: si está caída, el `send` de después va a fallar
   * igual; fingir una defensa aquí sería teatro.
   */
  private async dentroDelTope(automationId: string, tenantId: string, ahora: number): Promise<boolean> {
    try {
      const [na, nt] = await Promise.all([
        this.cuenta(claveDeVentana('a', automationId, ahora)),
        this.cuenta(claveDeVentana('t', tenantId, ahora)),
      ]);
      if (Math.random() < PURGA_PROBABILIDAD) {
        await this.prisma.hookRateWindow
          .deleteMany({ where: { createdAt: { lt: new Date(ahora - PURGA_ANTIGUEDAD_MS) } } })
          .catch(() => undefined);
      }
      return na <= TOPE_POR_MINUTO && nt <= TOPE_TENANT_POR_MINUTO;
    } catch (e) {
      this.logger.warn(`No se pudo contar el tope del hook: ${(e as Error).message}`);
      return true;
    }
  }

  private async cuenta(clave: string): Promise<number> {
    const filas = await this.prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO "HookRateWindow" (key, count)
      VALUES (${clave}, 1)
      ON CONFLICT (key) DO UPDATE SET count = "HookRateWindow".count + 1
      RETURNING count
    `;
    return filas[0]?.count ?? 1;
  }

  /**
   * El contexto del run. Si el disparador trae un `telefono` (interpolable contra el propio
   * cuerpo), se busca una conversación **que ya exista** de ese contacto para que
   * «Enviar mensaje» funcione.
   *
   * **Nunca crea contacto ni conversación.** Escribir primero es el camino del v5, con
   * `messaging/lifecycle.ts` y `limits.ts` detrás; colarse por aquí sería saltarse el freno
   * anti-baneo desde una URL pública. Si no resuelve, el run nace igual y sin conversación:
   * un flujo que solo crea un trato desde un formulario web no tiene por qué depender de un
   * teléfono, y el que sí la necesite falla con su mensaje de siempre en el paso.
   */
  private async contexto(tenantId: string, trigger: unknown, cuerpo: unknown): Promise<Contexto> {
    const base = (encontrada: boolean, contacto: any, conversationId: string | null): Contexto => ({
      mensaje: { texto: '', wamid: null },
      contacto: { id: contacto?.id ?? null, nombre: contacto?.name ?? null, waId: contacto?.waId ?? null },
      conversacion: { id: conversationId },
      disparador: { tipo: 'webhook.received', cuerpo: cuerpo ?? null, recibidoEn: new Date().toISOString(), conversacionEncontrada: encontrada },
      nodos: {},
      vars: {},
    });

    const crudo = leerTrigger(trigger).config?.telefono;
    if (typeof crudo !== 'string' || !crudo.trim()) return base(false, null, null);

    // Se interpola contra el contexto a medio hacer: la gracia es `{{disparador.cuerpo.tel}}`.
    const tel = parsePhone(interpolar(crudo, base(false, null, null)));
    if (!tel.ok) return base(false, null, null);

    const contacto = await this.prisma.contact.findFirst({
      // `phone` está a null en contactos viejos de Cloud API (solo se rellena desde WAHA), y
      // el `waId` de WAHA lleva sufijo: hay que mirar las tres formas o no se encuentra nada.
      where: {
        tenantId,
        isGroup: false,
        OR: [{ phone: tel.digits }, { waId: tel.digits }, { waId: `${tel.digits}@c.us` }],
      },
      select: { id: true, name: true, waId: true },
    });
    if (!contacto) return base(false, null, null);

    const conv = await this.prisma.conversation.findFirst({
      where: { tenantId, contactId: contacto.id, status: { not: 'closed' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return base(!!conv, contacto, conv?.id ?? null);
  }
}
