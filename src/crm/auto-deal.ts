// Alta automática de tratos (v8 feature 38): un entrante de quien no tiene trato abierto crea
// uno en la primera etapa del embudo.
//
// Función libre que recibe el PrismaService, NO un provider — mismo motivo y mismo patrón que
// `contacts/system-list.ts` y `crm/default-pipeline.ts`: esto lo llama el worker del webhook, y
// un provider obligaría a `WebhookModule` a importar `CrmModule`.
//
// Lo que NO hace, y es la decisión importante de la feature: **no clasifica la intención con un
// LLM**. El embudo es el número con el que el dueño proyecta ingresos, y un falso positivo ahí
// no es una tarjeta de más, es una decisión de negocio tomada sobre un dato inventado. La
// clasificación llegará como nodo del orquestador v3, con su propio interruptor, cuando el
// embudo manual tenga volumen con el que medir cuánto se equivoca.
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ensureDefaultPipeline } from './default-pipeline';
import { primeraEtapa } from './stages';
import { tituloPorDefecto } from './deals.query';
import { anotacionDe, decidirTareaAuto } from './auto-task';

const logger = new Logger('AutoDeal');

/**
 * Crea el trato del contacto si procede. Idempotente y a prueba de fallos.
 *
 * Es MEJOR ESFUERZO a propósito, con su propio `catch` y sin lanzar nunca: lo llama la ingesta
 * de un mensaje entrante, y perder el mensaje de un cliente por no poder anotar un trato sería
 * cambiar un problema pequeño por el único que el producto promete no tener.
 *
 * Solo se llama con ENTRANTES (lo decide el worker, igual que el alta en la cartera): el eco de
 * lo que el dueño manda desde su propio teléfono no es un prospecto.
 */
export async function autoDealOnInbound(
  prisma: PrismaService,
  tenantId: string,
  contactId: string,
  isGroup = false,
): Promise<void> {
  // Un grupo no es un cliente: su "contacto" es el grupo entero. Mismo corte que la cartera.
  if (isGroup) return;
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { autoDealOnInbound: true, timezone: true },
    });
    // Apagado por defecto, igual que `COLD_OUTREACH_ENABLED`: una regla que crea filas sola se
    // enciende a mano, y quien la enciende tiene que ser admin.
    if (!tenant?.autoDealOnInbound) return;

    // IDEMPOTENCIA POR CONDICIÓN, y sin ella esto no sirve: una conversación de veinte turnos
    // serían veinte tarjetas. Se mira si hay trato ABIERTO, no si hubo alguno: un contacto con
    // un trato ganado que vuelve a escribir SÍ genera trato nuevo, que es exactamente la
    // segunda venta al mismo cliente que el modelo existe para poder representar.
    const abierto = await prisma.deal.findFirst({
      where: { tenantId, contactId, status: 'open' },
      select: { id: true },
    });
    if (abierto) return;

    const contacto = await prisma.contact.findFirst({
      where: { id: contactId, tenantId },
      select: { name: true, waId: true },
    });
    if (!contacto) return;

    const pipeline = await ensureDefaultPipeline(prisma, tenantId);
    const etapa = primeraEtapa(pipeline.stages);

    await prisma.$transaction(async (tx) => {
      const deal = await tx.deal.create({
        data: {
          tenantId,
          contactId,
          pipelineId: pipeline.id,
          stageId: etapa.id,
          title: tituloPorDefecto(contacto.name, contacto.waId),
          // Sin monto: nadie lo sabe todavía. Y SIN DUEÑO: con `ownerId: null` la tarjeta la ve
          // todo el equipo y el primero que la reclama se la queda, que es cómo funciona el
          // alcance del embudo.
          amount: null,
          ownerId: null,
        },
        select: { id: true, title: true, contactId: true, ownerId: true },
      });

      // La etapa puede tener tarea automática configurada. Se consulta igual —aunque un trato
      // sin dueño siempre la omita— para tener UN solo camino: si algún día los tratos
      // automáticos llevan responsable, esto funciona sin tocarlo.
      const decision = decidirTareaAuto({
        stage: etapa,
        dealOwnerId: deal.ownerId,
        dealTitle: deal.title,
        ahora: new Date(),
        timezone: tenant.timezone,
      });
      if (decision.crear) {
        await tx.task.create({
          data: {
            tenantId,
            title: decision.title,
            type: decision.type,
            dueAt: decision.dueAt,
            assignedUserId: decision.assignedUserId,
            contactId: deal.contactId,
            dealId: deal.id,
            // `null` = lo creó el sistema. La columna es nulable justo para poder decirlo.
            createdById: null,
          },
        });
      }

      await tx.activity.create({
        data: {
          tenantId,
          type: 'deal_created',
          contactId,
          dealId: deal.id,
          // `authorId: null` = lo hizo el sistema, y el timeline lo dice. No hay usuario
          // ficticio "Sistema": un User que no puede entrar contamina GET /users y el borrado
          // de usuarios.
          authorId: null,
          data: { to: etapa.name, automatico: true, ...(anotacionDe(decision) ? { tareaAuto: anotacionDe(decision) } : {}) },
        },
      });
    });
  } catch (e) {
    // Ni un fallo de aquí puede subir: el mensaje del cliente ya está guardado y tiene que
    // aparecer en la bandeja.
    logger.warn(`No se pudo crear el trato automático de ${contactId}: ${(e as Error).message}`);
  }
}
