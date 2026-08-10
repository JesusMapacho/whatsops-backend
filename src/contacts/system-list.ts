// Cartera de sistema ("Todos mis contactos"): la que se rellena sola con quien nos
// escribe. Las carteras curadas se construyen encima, a mano.
//
// Funciones libres que reciben el PrismaService, NO un provider — mismo motivo y mismo
// patrón que `messaging/contact-resolve.ts`: esto lo llama el worker del webhook, y un
// provider obligaría a `WebhookModule` a importar `ContactsModule` para dos queries.
//
// Que solo se alimente de ENTRANTES no es un detalle de implementación: **es** la regla
// de reciprocidad. No hace falta comprobarla aparte porque el único sitio que llama aquí
// es la ingesta de un mensaje recibido.
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CARTERA_TODOS } from './contact-lists.service';

const logger = new Logger('SystemContactList');

// Id de la cartera de sistema del tenant, creándola si es la primera vez.
//
// Perezosa y no sembrada al crear el tenant: así los tenants que ya existen la tienen
// en cuanto reciben un mensaje, sin migración de datos ni backfill.
export async function ensureSystemList(prisma: PrismaService, tenantId: string): Promise<string> {
  const existing = await prisma.contactList.findFirst({
    where: { tenantId, isSystem: true },
    select: { id: true },
  });
  if (existing) return existing.id;
  try {
    const created = await prisma.contactList.create({
      data: { tenantId, name: CARTERA_TODOS, isSystem: true },
      select: { id: true },
    });
    return created.id;
  } catch (e: any) {
    // Carrera entre dos workers, o ya existía una cartera manual con ese nombre. En los
    // dos casos la de verdad es la que está en DB.
    if (e?.code !== 'P2002') throw e;
    const row = await prisma.contactList.findFirst({
      where: { tenantId, name: CARTERA_TODOS },
      select: { id: true },
    });
    if (row) return row.id;
    throw e;
  }
}

// Mete el contacto en la cartera de sistema. Idempotente y a prueba de fallos.
//
// Es MEJOR ESFUERZO a propósito: lo llama la ingesta de un mensaje entrante, y perder un
// mensaje de un cliente por no poder anotarlo en una lista sería cambiar un problema
// pequeño por el único que el producto promete no tener.
export async function addToSystemList(
  prisma: PrismaService,
  tenantId: string,
  contactId: string,
  isGroup = false,
): Promise<void> {
  // Un grupo no es un cliente: su "contacto" es el grupo entero y no se le manda ni un
  // masivo ni un estado.
  if (isGroup) return;
  try {
    const listId = await ensureSystemList(prisma, tenantId);
    await prisma.contactListMember.upsert({
      where: { contactListId_contactId: { contactListId: listId, contactId } },
      create: { contactListId: listId, contactId },
      update: {},
    });
  } catch (e) {
    logger.warn(`No se pudo añadir el contacto a la cartera de sistema: ${(e as Error).message}`);
  }
}
