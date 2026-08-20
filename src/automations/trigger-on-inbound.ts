// Disparo de automatizaciones desde un mensaje entrante (v3 feature 18).
//
// Función libre que recibe el PrismaService y la cola, NO un provider — mismo motivo y mismo
// patrón que `crm/auto-deal.ts` y `contacts/system-list.ts`: esto lo llama el worker del
// webhook, y un provider obligaría a `WebhookModule` a importar el módulo del orquestador.
//
// MEJOR ESFUERZO, con su propio `catch` y sin lanzar nunca: el mensaje del cliente ya está
// guardado y tiene que aparecer en la bandeja. Que una automatización no arranque es un
// problema; perder el mensaje es EL problema que el producto promete no tener.
import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { contextoDeMensaje } from './contexto';
import { especificidad, evaluarEntrante } from './triggers';
import { crearRun } from './automations.service';

const logger = new Logger('AutomationTrigger');

export interface EntranteParaAutomatizar {
  tenantId: string;
  conversationId: string;
  contacto: { id: string; name: string | null; waId: string };
  texto: string;
  wamid: string | null;
  esGrupo: boolean;
}

export async function triggerOnInbound(
  prisma: PrismaService,
  cola: Queue,
  entrante: EntranteParaAutomatizar,
): Promise<void> {
  try {
    // 1. ¿Hay un run esperando la RESPUESTA de este cliente? Reanudarlo tiene prioridad sobre
    //    crear otro: si no, contestar «sí» abriría una segunda conversación paralela con la
    //    misma persona.
    //
    //    El `findFirst` sin `orderBy` es correcto SOLO porque la unique
    //    `(tenantId, waitingConversationId)` garantiza que hay una fila como máximo. Si esa
    //    unique se cayera, esto entregaría la respuesta a uno de los dos al azar y el otro se
    //    quedaría dormido para siempre — es la razón entera de que el candado exista.
    //
    //    Y solo casan los que esperan respuesta: un run aparcado por TIEMPO tiene esta columna
    //    a null, así que un mensaje llegado durante un «Esperar N minutos» ya no se cae por el
    //    agujero de antes y dispara con normalidad.
    const esperando = await prisma.automationRun.findFirst({
      where: { tenantId: entrante.tenantId, waitingConversationId: entrante.conversationId, status: 'waiting' },
      select: { id: true, context: true },
    });
    if (esperando) {
      const ctx = (esperando.context ?? {}) as Record<string, unknown>;
      await prisma.automationRun.update({
        where: { id: esperando.id },
        data: {
          status: 'running',
          // La respuesta del cliente entra al contexto: es justo el dato por el que se
          // esperaba, y lo que van a mirar los comparadores de después.
          context: { ...ctx, mensaje: { texto: entrante.texto, wamid: entrante.wamid } } as any,
        },
      });
      await cola.add('run', { runId: esperando.id });
      return;
    }

    // `orderBy` explícito y no el que salga: sin él Postgres devuelve el orden físico del
    // heap, y como un UPDATE reescribe la fila al final, cuál de dos automatizaciones
    // respondía cambiaba solo porque habías editado la otra. Indefinido de verdad, no
    // «indefinido pero en la práctica estable». Aquí fija el desempate entre iguales, y la
    // preferencia de verdad la pone `especificidad` más abajo.
    const activas = await prisma.automation.findMany({
      where: { tenantId: entrante.tenantId, status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, trigger: true },
    });
    if (!activas.length) return;

    // Se guarda el resultado entero y no solo el sí/no: la palabra que coincidió va al
    // contexto como `disparador.palabra`, y aquí es el único sitio donde se conoce.
    const candidatas = activas
      .map((a) => ({ a, disparo: evaluarEntrante(a.trigger, { texto: entrante.texto, esGrupo: entrante.esGrupo }) }))
      .filter((c) => c.disparo.dispara)
      // La MÁS ESPECÍFICA primero: una palabra clave gana a «entra un mensaje». `sort` es
      // estable, así que entre dos igual de específicas manda el `orderBy` de arriba.
      .sort((x, y) => especificidad(y.a.trigger) - especificidad(x.a.trigger));

    if (!candidatas.length) return;

    // Solo la PRIMERA. Un mensaje que dispara tres automatizaciones a la vez son tres
    // respuestas automáticas al mismo cliente. (Lo de «solo cabe un run activo por
    // conversación» ya no aplica: desde la feature 41 un run corriendo no reserva nada, y lo
    // único exclusivo es quién se queda con la próxima respuesta.)
    const elegida = candidatas[0];
    const run = await crearRun(prisma, {
      tenantId: entrante.tenantId,
      automationId: elegida.a.id,
      conversationId: entrante.conversationId,
      contexto: contextoDeMensaje({
        texto: entrante.texto,
        wamid: entrante.wamid,
        tipo: (elegida.a.trigger as { type?: string } | null)?.type,
        palabra: elegida.disparo.palabra,
        contacto: { id: entrante.contacto.id, nombre: entrante.contacto.name, waId: entrante.contacto.waId },
        conversationId: entrante.conversationId,
      }),
    });
    // `null` = ya hay un run aparcado esperando la respuesta de esta persona, así que este
    // mensaje es para él y no para arrancar otro. Se LOGUEA: el silencio de antes es la mitad
    // de por qué «la automatización dejó de responder» era indiagnosticable.
    if (run) await cola.add('run', { runId: run.id });
    else {
      logger.log(
        `El mensaje no disparó «${elegida.a.id}»: ya hay una ejecución esperando respuesta en ` +
          `la conversación ${entrante.conversationId}.`,
      );
    }
  } catch (e) {
    logger.warn(`No se pudo disparar la automatización del entrante: ${(e as Error).message}`);
  }
}
