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
import { evaluarEntrante } from './triggers';
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
    // 1. ¿Hay un run esperando la respuesta de este cliente? Reanudarlo tiene prioridad
    //    sobre crear otro: si no, contestar «sí» abriría una segunda conversación paralela
    //    con la misma persona.
    const esperando = await prisma.automationRun.findFirst({
      where: { tenantId: entrante.tenantId, activeConversationId: entrante.conversationId, status: 'waiting' },
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

    const activas = await prisma.automation.findMany({
      where: { tenantId: entrante.tenantId, status: 'active' },
      select: { id: true, trigger: true },
    });
    if (!activas.length) return;

    // Se guarda el resultado entero y no solo el sí/no: la palabra que coincidió va al
    // contexto como `disparador.palabra`, y aquí es el único sitio donde se conoce.
    const candidatas = activas
      .map((a) => ({ a, disparo: evaluarEntrante(a.trigger, { texto: entrante.texto, esGrupo: entrante.esGrupo }) }))
      .filter((c) => c.disparo.dispara);
    if (!candidatas.length) return;

    // Solo la PRIMERA que coincide. Un mensaje que dispara tres automatizaciones a la vez
    // son tres respuestas automáticas al mismo cliente, y además solo cabe un run activo por
    // conversación (lo impone la unique de la base). Que el orden lo decida la más reciente
    // es discutible; que se manden tres mensajes, no.
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
    // `null` = ya había un run vivo en esa conversación. No es un error: es el freno.
    if (run) await cola.add('run', { runId: run.id });
  } catch (e) {
    logger.warn(`No se pudo disparar la automatización del entrante: ${(e as Error).message}`);
  }
}
