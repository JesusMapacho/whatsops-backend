// Pipeline por defecto del tenant.
//
// PEREZOSA y no sembrada al crear el tenant, con el mismo criterio (y el mismo patrón de
// carrera) que `contacts/system-list.ts`: así los tenants que YA existen la tienen en
// cuanto alguien abre el embudo, sin migración de datos ni backfill. Cuando esto se
// escribió había 18 tenants vivos.
//
// Función libre que recibe el PrismaService, no un provider: la llama tanto el servicio
// del embudo como el worker del webhook (feature 38, alta automática de tratos), y un
// provider obligaría a `WebhookModule` a importar `CrmModule` por dos queries.
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ETAPAS_INICIALES, PIPELINE_INICIAL } from './stages';

const logger = new Logger('DefaultPipeline');

export interface PipelineConEtapas {
  id: string;
  name: string;
  isDefault: boolean;
  stages: Array<{ id: string; name: string; position: number }>;
}

/**
 * La pipeline por defecto del tenant, creándola con sus cuatro etapas si es la primera vez.
 *
 * Un tablero vacío con un cartel «crea tu primera etapa» es la forma más rápida de que
 * nadie vuelva a entrar; estas cuatro son las que el negocio va a RENOMBRAR, no inventar.
 */
export async function ensureDefaultPipeline(
  prisma: PrismaService,
  tenantId: string,
): Promise<PipelineConEtapas> {
  const ya = await buscar(prisma, tenantId);
  if (ya) return ya;

  try {
    // Pipeline y etapas en una transacción: una pipeline sin etapas no admite tratos, así
    // que a medias no sirve de nada.
    const creada = await prisma.$transaction(async (tx) => {
      const p = await tx.pipeline.create({
        data: { tenantId, name: PIPELINE_INICIAL, isDefault: true },
      });
      await tx.stage.createMany({
        data: ETAPAS_INICIALES.map((name, position) => ({
          tenantId,
          pipelineId: p.id,
          name,
          position,
        })),
      });
      return p.id;
    });
    const conEtapas = await buscarPorId(prisma, tenantId, creada);
    if (conEtapas) return conEtapas;
  } catch (e: any) {
    // P2002 = carrera con otra petición, o ya existía una pipeline llamada "Ventas" creada
    // a mano. En los dos casos la de verdad es la que está en la base.
    if (e?.code !== 'P2002') throw e;
    logger.debug(`Carrera creando la pipeline por defecto de ${tenantId}; uso la existente`);
  }

  const tras = await buscar(prisma, tenantId);
  if (tras) return tras;
  throw new Error('No se pudo asegurar la pipeline por defecto');
}

// La marcada por defecto; si ninguna lo está (el admin desmarcó todas), la primera que
// haya. Devolver null cuando hay pipelines pero ninguna por defecto dejaría el tablero
// vacío con datos dentro.
async function buscar(prisma: PrismaService, tenantId: string): Promise<PipelineConEtapas | null> {
  const rows = await prisma.pipeline.findMany({
    where: { tenantId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    take: 1,
    include: {
      stages: { orderBy: { position: 'asc' }, select: { id: true, name: true, position: true } },
    },
  });
  const p = rows[0];
  // Una pipeline SIN etapas no sirve: se trata como si no existiera para que se siembre.
  // Pasa si alguien borró la última etapa a mano en la base.
  return p && p.stages.length ? p : null;
}

async function buscarPorId(
  prisma: PrismaService,
  tenantId: string,
  id: string,
): Promise<PipelineConEtapas | null> {
  return prisma.pipeline.findFirst({
    where: { id, tenantId },
    include: {
      stages: { orderBy: { position: 'asc' }, select: { id: true, name: true, position: true } },
    },
  });
}
