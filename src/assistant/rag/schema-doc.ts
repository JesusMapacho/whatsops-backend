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
    content: `Tabla "Conversation": una conversación con un contacto por algún canal.
Columnas: id (text), "tenantId" (text), platform (enum: 'whatsapp'|'instagram'|'messenger'|'waha'),
platform 'waha' = WhatsApp por QR (transporte no oficial); para "WhatsApp" en general, incluir ambos.
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
    content: `Tabla "Contact": persona con la que se conversa por algún canal.
Columnas: id (text), "tenantId" (text), platform (enum: 'whatsapp'|'instagram'|'messenger'|'waha'),
"waId" (id externo del usuario: wa_id / PSID / IGSID; en 'waha' es '<numero>@c.us'), name (text, puede ser NULL),
phone (text, puede ser NULL: teléfono real en dígitos), email (text, NULL),
company (text, NULL: empresa a la que pertenece), "ownerId" (vendedor dueño de la relación, NULL),
"createdAt", "updatedAt". Único por ("tenantId",platform,"waId").
Uso: buscar contactos por nombre, waId, empresa o dueño; relacionar con "Conversation"."contactId"
y con "Deal"."contactId".`,
  },
  {
    id: 'Activity',
    content: `Tabla "Activity": el historial (timeline) de todo lo que ha pasado con un contacto.
Sustituye a la vieja tabla "Note", que ya NO existe: las notas internas son filas con type='note'.
Columnas: id (text), "tenantId" (text),
type (enum: 'note'|'call'|'meeting'|'stage_change'|'deal_created'|'deal_won'|'deal_lost'|'task_done'),
"contactId" (FK -> "Contact".id, NUNCA nulo), "dealId" (FK -> "Deal".id, puede ser NULL),
"conversationId" (FK -> "Conversation".id, puede ser NULL), "taskId" (FK -> "Task".id, puede ser NULL),
"authorId" (usuario autor; NULL = lo hizo el sistema), body (text, puede ser NULL),
data (jsonb: en 'stage_change' lleva {from,to}; en 'deal_won' lleva {amount}),
"occurredAt" (cuándo PASÓ — ordenar por esta), "createdAt" (cuándo se registró).
Uso: historial de un contacto o de un trato; notas internas = type='note'; llamadas registradas
a mano = type='call'. Para "notas" filtrar SIEMPRE por type='note', porque esta tabla también
lleva eventos del CRM.`,
  },
  {
    id: 'Deal',
    content: `Tabla "Deal": un trato comercial (oportunidad de venta) que se intenta cerrar con un contacto.
NO es la conversación: un mismo contacto puede tener varios tratos a lo largo del tiempo.
Columnas: id (text), "tenantId" (text), "contactId" (FK -> "Contact".id),
"pipelineId" (FK -> "Pipeline".id), "stageId" (FK -> "Stage".id = etapa del embudo en que va),
title (text), amount (numeric(14,2), puede ser NULL; la moneda es "Tenant".currency),
status (enum: 'open' | 'won' | 'lost'), "lostReason" (text, NULL salvo en perdidos),
"ownerId" (vendedor dueño; NULL = sin asignar, lo ve todo el equipo),
"expectedCloseAt" (fecha esperada de cierre), "closedAt" (cuándo se ganó o perdió), "createdAt", "updatedAt".
Uso: valor del embudo = SUM(amount) con status='open'. Ganado/perdido salen de status,
NO de la etapa: 'won'/'lost' no son etapas. Tasa de cierre = ganados/(ganados+perdidos).`,
  },
  {
    id: 'Pipeline',
    content: `Tabla "Pipeline": un embudo de ventas del negocio (puede haber varios).
Columnas: id (text), "tenantId" (text), name (text), "isDefault" (boolean), "createdAt", "updatedAt".
Único por ("tenantId",name). Uso: agrupar tratos por embudo.`,
  },
  {
    id: 'Stage',
    content: `Tabla "Stage": una etapa ABIERTA del embudo (p. ej. 'Nuevo prospecto', 'Cotización enviada').
Ganado y perdido NO son etapas: son "Deal".status.
Columnas: id (text), "tenantId" (text), "pipelineId" (FK -> "Pipeline".id), name (text),
position (integer, orden de izquierda a derecha empezando en 0),
"autoTaskTitle" (text, NULL) y "autoTaskDays" (integer, NULL) = tarea que se crea sola al caer aquí,
"createdAt", "updatedAt".
Uso: contar o sumar tratos por etapa; ordenar por position para respetar el orden del embudo.`,
  },
  {
    id: 'Task',
    content: `Tabla "Task": una tarea o acción de seguimiento con fecha (llamar, escribir, reunión).
NO tiene columna de estado: "completedAt" NULL = pendiente; con valor = hecha.
Atrasada = "completedAt" IS NULL AND "dueAt" < ahora.
Columnas: id (text), "tenantId" (text), title (text),
type (enum: 'call'|'whatsapp'|'email'|'meeting'|'other'), "dueAt" (cuándo toca, NUNCA nulo),
"assignedUserId" (FK -> usuario responsable, NUNCA nulo), "contactId" (FK, puede ser NULL),
"dealId" (FK -> "Deal".id, puede ser NULL), "completedAt" (timestamp, NULL si pendiente),
outcome (text: qué pasó al completarla), "createdById", "createdAt", "updatedAt".
Uso: tareas pendientes o atrasadas por responsable; tareas de un trato o de un contacto.`,
  },
  {
    id: 'Tag',
    content: `Tabla "Tag": etiqueta del tenant para describir y filtrar contactos (p. ej. 'VIP').
No autoriza nada: a quién se le puede enviar lo decide la cartera ("ContactList"), no la etiqueta.
Columnas: id (text), "tenantId" (text), name (text), color (text), "createdAt".
Único por ("tenantId",name).
Uso: listar las etiquetas del negocio. La relación con los contactos vive en la tabla puente
"ContactTag", que NO es consultable (no tiene "tenantId"), así que no se puede contar contactos
por etiqueta desde aquí.`,
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
    content: `Tabla "WabaConnection": conexión a un canal (WhatsApp / Instagram / Messenger / WhatsApp por QR).
Columnas: id (text), "tenantId" (text), platform (enum: 'whatsapp'|'instagram'|'messenger'|'waha'),
"wabaId" (text, NULL, WhatsApp), "phoneNumberId" (text, id externo del canal; en 'waha' es el nombre de sesión),
"businessId" (text, NULL), "baseUrl" (text, NULL, URL de la instancia WAHA propia),
source (enum: 'embedded_signup'|'manual_token'|'waha_qr'),
status (text: 'active' en Meta; en 'waha' el estado de la sesión: 'WORKING'|'SCAN_QR_CODE'|'FAILED'|…),
"createdAt", "updatedAt". NUNCA exponer "accessTokenEnc" (token/api key cifrada, secreto).
Uso: listar conexiones y su estado. No seleccionar la columna del token.`,
  },
];
