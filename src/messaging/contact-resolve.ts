// Resolución de identidad de un contacto y apertura de su conversación.
//
// Existe por un bug real: `contact.upsert` clava en `[tenantId, platform, waId]`, y
// la MISMA persona puede llegar con dos ids distintos:
//   · WAHA con LID addressing → `175647100039313@lid` en un mensaje y
//     `5218715172350@c.us` en las APIs de chats/historial.
//   · Cloud API en México y Argentina → el `wa_id` que devuelve Meta NO es lo que
//     marcaste (`+52 1 871…` se guarda como `52871…`).
// Sin puente, cada variante crea un contacto y un hilo aparte, y el agente ve dos
// conversaciones con la misma persona. `Contact.phone` + su índice es el puente.
//
// Son funciones libres que reciben el PrismaService, NO un provider: `MessagingModule`
// ya importa `WahaModule` y un provider aquí crearía un ciclo con `WebhookModule`.
// Y al haber una sola función, los dos caminos (webhook y conversación nueva) no
// pueden derivar.
import { BadRequestException } from '@nestjs/common';
import { Contact, Conversation, Platform } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// ── Puras (ver contact-resolve.check.ts) ────────────────────────────────────

// Normaliza un teléfono a solo dígitos. No se usa una librería: el único formato
// que aceptamos es "lada de país + número", que es lo que piden los dos proveedores.
export type PhoneResult = { ok: true; digits: string } | { ok: false; reason: string };

export function parsePhone(raw: unknown): PhoneResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'Indica un número de teléfono.' };
  }
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    return {
      ok: false,
      reason: 'El número debe llevar lada de país y tener entre 8 y 15 dígitos.',
    };
  }
  if (digits.startsWith('0')) {
    return { ok: false, reason: 'Quita el 0 inicial: usa el formato internacional.' };
  }
  return { ok: true, digits };
}

// ¿Este waId es la clave DEFINITIVA del contacto en este canal?
//
// Un `@lid` identifica a la persona pero no sirve para enviar, ni para el historial,
// ni para la foto de perfil. Un `@c.us` sí. En los canales de Meta el id que llega
// siempre es el bueno (el problema del 521 se arregla al ENVIAR, no aquí).
export function isCanonicalWaId(platform: Platform, waId: string): boolean {
  if (platform !== 'waha') return true;
  return !waId.endsWith('@lid');
}

// Entre dos ids del MISMO humano, gana el que sirve para todo. Simétrico a propósito:
// el orden de los argumentos no debe cambiar el resultado.
export function preferWaId(platform: Platform, a: string, b: string): string {
  const aOk = isCanonicalWaId(platform, a);
  const bOk = isCanonicalWaId(platform, b);
  if (aOk === bOk) return a; // empate → el primero, para no re-clavijar en bucle
  return aOk ? a : b;
}

// waId con el que crear un contacto en frío cuando el proveedor aún no nos ha dado
// el canónico. Es un FALLBACK: si se puede preguntar (Cloud lo devuelve al enviar,
// WAHA tiene check-exists), se pregunta.
export function coldWaId(platform: Platform, digits: string): string {
  if (platform === 'waha') return `${digits}@c.us`;
  if (platform === 'whatsapp') return digits; // Graph espera el número a secas
  throw new BadRequestException(
    'Este canal no permite iniciar conversación: no existe forma de derivar su id desde un teléfono.',
  );
}

// Id canónico que devuelve el proveedor al enviar. Cloud API lo pone en
// `contacts[0].wa_id` del MISMO objeto del que ya sacamos `messages[0].id`.
// Es la fuente de verdad: mejor esto que cualquier id que construyamos.
export function canonicalWaId(json: any): string | null {
  const id = json?.contacts?.[0]?.wa_id;
  return typeof id === 'string' && id ? id : null;
}

// ── Sobre Prisma ────────────────────────────────────────────────────────────

export interface ResolveInput {
  tenantId: string;
  platform: Platform;
  waId: string;
  phone?: string;
  name?: string | null;
  isGroup?: boolean;
}

// Devuelve el Contact de esta persona, uniendo variantes del mismo id cuando se
// puede hacer con seguridad.
export async function resolveContact(
  prisma: PrismaService,
  input: ResolveInput,
): Promise<Contact> {
  const { tenantId, platform, waId, phone, name, isGroup } = input;

  const contact = await prisma.contact.upsert({
    where: { tenantId_platform_waId: { tenantId, platform, waId } },
    create: {
      tenantId,
      platform,
      waId,
      name: name ?? null,
      ...(phone ? { phone } : {}),
      ...(isGroup ? { isGroup: true } : {}),
    },
    update: {
      ...(name ? { name } : {}),
      ...(phone ? { phone } : {}),
    },
  });

  // El puente por teléfono solo se intenta cuando hace falta, así el camino caliente
  // (un `@c.us` o un id de Meta, que ya son definitivos) no paga ninguna query extra.
  //
  // El guard de `isGroup` es CATASTRÓFICO si falta: el `remoteJidAlt` de un grupo
  // podría traer el número de un miembro, y entonces el hilo del grupo se fusionaría
  // con la conversación privada de esa persona. `decodeWahaMessage` ya omite el
  // teléfono en grupos; esto lo comprueba otra vez.
  if (!phone || isGroup || contact.isGroup || isCanonicalWaId(platform, waId)) {
    return contact;
  }

  const twin = await prisma.contact.findFirst({
    where: { tenantId, platform, phone, isGroup: false, id: { not: contact.id } },
    orderBy: { createdAt: 'asc' },
  });
  if (!twin) return contact;

  // ponytail: nunca se FUSIONAN dos Contact que ya existen; solo se re-clavija uno
  // cuyo waId aún no era el definitivo. Techo: los duplicados creados ANTES de este
  // cambio siguen partidos en dos hilos. Upgrade: script de backfill que agrupe por
  // (tenantId, platform, phone), elija el canónico y mueva Conversation.contactId —
  // revisado a mano, jamás en caliente. Fusionar mal une los hilos de DOS personas
  // distintas, que es peor que duplicar uno.
  if (preferWaId(platform, twin.waId, waId) === twin.waId) return twin;

  try {
    return await prisma.contact.update({
      where: { id: twin.id },
      data: { waId, ...(name ? { name } : {}) },
    });
  } catch (e: any) {
    // Carrera: otro proceso re-clavijó primero. El nuestro sirve igual.
    if (e?.code === 'P2002') return contact;
    throw e;
  }
}

// Reutiliza la conversación abierta o crea una nueva.
//
// `inbound: false` deja `lastInboundAt` en NULL, y ese null es lo ÚNICO que mantiene
// `isWithinWindow` en false y obliga a Cloud API a usar plantilla. Si alguien lo
// rellena para que la UI se vea ordenada, se desbloquea el texto libre a
// desconocidos en el canal oficial → 131047 en serie → la calidad de la WABA cae.
export async function openConversation(
  prisma: PrismaService,
  input: {
    tenantId: string;
    platform: Platform;
    contactId: string;
    wabaConnectionId: string;
    inbound: boolean;
  },
): Promise<Conversation> {
  const { tenantId, platform, contactId, wabaConnectionId, inbound } = input;
  const open = await prisma.conversation.findFirst({
    where: { tenantId, contactId, wabaConnectionId, status: { not: 'closed' } },
    orderBy: { createdAt: 'desc' },
  });
  if (open) {
    return inbound
      ? prisma.conversation.update({
          where: { id: open.id },
          data: { lastInboundAt: new Date() },
        })
      : open;
  }
  return prisma.conversation.create({
    data: {
      tenantId,
      platform,
      contactId,
      wabaConnectionId,
      status: 'open',
      ...(inbound ? { lastInboundAt: new Date() } : {}),
      // Este es el ÚNICO sitio donde nacen conversaciones, así que es el único donde se
      // puede saber quién la abrió. Después de la primera respuesta ya no se distingue.
      initiatedByUs: !inbound,
    },
  });
}
