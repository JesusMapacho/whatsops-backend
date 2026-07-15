// Fuente del RAG: ESQUEMA documentado (nunca datos). Un chunk por tabla consultable.
// Derivado a mano de prisma/schema.prisma. Debe coincidir con ALLOWED_TABLES (sql-guard)
// y con las tablas con RLS (assistant-setup.sql). Si cambia el modelo, actualizar y reindexar.
export interface SchemaDoc {
  id: string; // = nombre de tabla; sirve de clave para upsert idempotente
  content: string;
}

export const SCHEMA_DOCS: SchemaDoc[] = [
  {
    id: 'Conversation',
    content: `Tabla "Conversation": una conversación con un contacto por algún canal de Meta.
Columnas: id (text), "tenantId" (text), platform (enum: 'whatsapp'|'instagram'|'messenger'),
"contactId" (FK -> "Contact".id), "wabaConnectionId" (FK -> "WabaConnection".id),
status (enum: 'open' | 'pending' | 'closed'), "assignedUserId" (FK -> usuario asignado, puede ser NULL),
"lastInboundAt" (timestamp del último mensaje entrante), "lastReadAt" (timestamp de última lectura),
"createdAt", "updatedAt".
Uso: contar/listar conversaciones por estado, asignación o fecha. "abiertas" = status = 'open'.`,
  },
  {
    id: 'Message',
    content: `Tabla "Message": un mensaje dentro de una conversación.
Columnas: id (text), "tenantId" (text), "conversationId" (FK -> "Conversation".id),
direction (enum: 'in' | 'out'), type (text: 'text','image',...), payload (jsonb),
status (enum: 'sent'|'delivered'|'read'|'failed'), "createdAt".
Uso: contar mensajes, entrantes ('in') vs salientes ('out'), por conversación o fecha.`,
  },
  {
    id: 'Contact',
    content: `Tabla "Contact": persona con la que se conversa por algún canal de Meta.
Columnas: id (text), "tenantId" (text), platform (enum: 'whatsapp'|'instagram'|'messenger'),
"waId" (id externo del usuario: wa_id / PSID / IGSID), name (text, puede ser NULL),
"createdAt", "updatedAt". Único por ("tenantId",platform,"waId").
Uso: buscar contactos por nombre o waId; relacionar con "Conversation"."contactId".`,
  },
  {
    id: 'Note',
    content: `Tabla "Note": nota interna en una conversación (no se envía a WhatsApp).
Columnas: id (text), "tenantId" (text), "conversationId" (FK -> "Conversation".id),
"authorId" (usuario autor), body (text), "createdAt".
Uso: contar/listar notas por conversación o autor.`,
  },
  {
    id: 'Template',
    content: `Tabla "Template": plantilla de mensaje aprobada por Meta.
Columnas: id (text), "tenantId" (text), name (text), language (text), category (text, NULL),
status (text, NULL), body (text, NULL), "createdAt", "updatedAt". Único por ("tenantId",name,language).
Uso: listar plantillas por estado, idioma o categoría.`,
  },
  {
    id: 'CannedResponse',
    content: `Tabla "CannedResponse": respuesta rápida interna del tenant (texto reutilizable).
Columnas: id (text), "tenantId" (text), title (text), body (text), "createdAt", "updatedAt".
Único por ("tenantId",title). Uso: listar/buscar respuestas rápidas por título.`,
  },
  {
    id: 'WabaConnection',
    content: `Tabla "WabaConnection": conexión a un canal de Meta (WhatsApp / Instagram / Messenger).
Columnas: id (text), "tenantId" (text), platform (enum: 'whatsapp'|'instagram'|'messenger'),
"wabaId" (text, NULL, WhatsApp), "phoneNumberId" (text, id externo del canal),
"businessId" (text, NULL), source (enum: 'embedded_signup'|'manual_token'), status (text, default 'active'),
"createdAt", "updatedAt". NUNCA exponer "accessTokenEnc" (token cifrado, secreto).
Uso: listar conexiones y su estado. No seleccionar la columna del token.`,
  },
];
