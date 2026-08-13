-- CRM: modelo de datos y timeline (v8 feature 34).
--
-- ORDEN IMPORTANTE al final del archivo: se crea "Activity", se COPIAN las filas de
-- "Note" dentro, y solo entonces se borra "Note". Si el DROP fuera antes, se perderia
-- todo el historial de notas internas del tenant.

CREATE TYPE "DealStatus" AS ENUM ('open', 'won', 'lost');
CREATE TYPE "TaskType" AS ENUM ('call', 'whatsapp', 'email', 'meeting', 'other');
CREATE TYPE "ActivityType" AS ENUM ('note', 'call', 'meeting', 'stage_change', 'deal_created', 'deal_won', 'deal_lost', 'task_done');

-- El embudo. Varias por tenant: dos procesos de venta distintos no se comparan en el
-- mismo tablero. La UI solo pinta el selector si hay mas de una.
CREATE TABLE "Pipeline" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pipeline_pkey" PRIMARY KEY ("id")
);

-- Etapa ABIERTA. Ganado/perdido no estan aqui: son "Deal".status.
-- "position" SIN unique a proposito: un unique obliga a valores temporales para
-- intercambiar dos etapas. Reordenar reescribe todas las posiciones en una transaccion.
CREATE TABLE "Stage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "autoTaskTitle" TEXT,
    "autoTaskDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Stage_pkey" PRIMARY KEY ("id")
);

-- La venta concreta. No es la conversacion: un hilo lleva la venta de marzo y la de
-- septiembre, cerrarlo no es ganar nada, y no tiene donde poner 3000.
-- "amount" es NUMERIC y no double: es dinero. Sin columna de moneda (sale de Tenant).
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(14,2),
    "status" "DealStatus" NOT NULL DEFAULT 'open',
    "lostReason" TEXT,
    "ownerId" TEXT,
    "expectedCloseAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- La proxima accion con fecha. Sin enum de estado: "completedAt" nulo es pendiente, y
-- atrasada/hoy/proxima se derivan de "dueAt" (src/crm/tasks.buckets.ts).
-- "assignedUserId" NO nulable: una tarea de nadie no la hace nadie.
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "TaskType" NOT NULL DEFAULT 'call',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "assignedUserId" TEXT NOT NULL,
    "contactId" TEXT,
    "dealId" TEXT,
    "completedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- El timeline por contacto, append-only. Absorbe la vieja "Note" (ver el final).
-- "contactId" es obligatorio: el timeline es por contacto y siempre hay uno.
-- "authorId" nulo = lo hizo el sistema; no hay usuario ficticio "Sistema".
-- "occurredAt" no es "createdAt": una llamada se registra despues de ocurrir.
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "contactId" TEXT NOT NULL,
    "dealId" TEXT,
    "conversationId" TEXT,
    "taskId" TEXT,
    "authorId" TEXT,
    "body" TEXT,
    "data" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- Etiqueta para DESCRIBIR y FILTRAR. No autoriza nada: a quien le envio sigue siendo
-- de "ContactList" (carteras). "color" es un token del sistema de diseno, no un hex
-- libre (con hex libre el tenant elige gris sobre gris y no se lee en tema oscuro).
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'neutral',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContactTag" (
    "contactId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "ContactTag_pkey" PRIMARY KEY ("contactId","tagId")
);

-- Un indice por consulta real, no por si acaso.
CREATE UNIQUE INDEX "Pipeline_tenantId_name_key" ON "Pipeline"("tenantId", "name");
CREATE INDEX "Pipeline_tenantId_idx" ON "Pipeline"("tenantId");
CREATE INDEX "Stage_pipelineId_position_idx" ON "Stage"("pipelineId", "position");
CREATE INDEX "Stage_tenantId_idx" ON "Stage"("tenantId");
CREATE INDEX "Deal_tenantId_status_idx" ON "Deal"("tenantId", "status");
CREATE INDEX "Deal_tenantId_pipelineId_stageId_idx" ON "Deal"("tenantId", "pipelineId", "stageId");
CREATE INDEX "Deal_tenantId_ownerId_idx" ON "Deal"("tenantId", "ownerId");
CREATE INDEX "Deal_tenantId_contactId_idx" ON "Deal"("tenantId", "contactId");
-- El orden de las columnas importa: es "mis tareas pendientes por fecha", la unica
-- consulta que corre en cada carga de pantalla.
CREATE INDEX "Task_tenantId_assignedUserId_completedAt_dueAt_idx" ON "Task"("tenantId", "assignedUserId", "completedAt", "dueAt");
CREATE INDEX "Task_tenantId_dealId_idx" ON "Task"("tenantId", "dealId");
CREATE INDEX "Task_tenantId_contactId_idx" ON "Task"("tenantId", "contactId");
CREATE INDEX "Activity_tenantId_contactId_occurredAt_idx" ON "Activity"("tenantId", "contactId", "occurredAt");
CREATE INDEX "Activity_tenantId_dealId_occurredAt_idx" ON "Activity"("tenantId", "dealId", "occurredAt");
-- La bandeja lista las notas de un hilo por este camino.
CREATE INDEX "Activity_conversationId_type_idx" ON "Activity"("conversationId", "type");
CREATE UNIQUE INDEX "Tag_tenantId_name_key" ON "Tag"("tenantId", "name");
CREATE INDEX "Tag_tenantId_idx" ON "Tag"("tenantId");
CREATE INDEX "ContactTag_tagId_idx" ON "ContactTag"("tagId");

ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Stage" ADD CONSTRAINT "Stage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Stage" ADD CONSTRAINT "Stage_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Sin CASCADE ni SET NULL: borrar una etapa con tratos exige decir a donde van
-- ("moveToStageId"), asi que la base rechaza el borrado y no deja tratos apuntando al
-- vacio ni los borra en silencio.
--
-- NO ACTION y no RESTRICT, aunque el efecto buscado sea el mismo: RESTRICT se comprueba
-- de inmediato y fila a fila, asi que en un borrado en cascada (tirar un Tenant o una
-- Pipeline) si Postgres llega a "Stage" antes que a "Deal", la comprobacion salta contra
-- tratos que se estan borrando en la MISMA sentencia y el borrado del tenant falla.
-- NO ACTION se difiere al final de la sentencia: para entonces los tratos ya no estan.
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "Stage"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL y no CASCADE: borrar una tarea no puede borrar el registro de que se hizo.
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactTag" ADD CONSTRAINT "ContactTag_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactTag" ADD CONSTRAINT "ContactTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Contacto enriquecido (feature 35). La IDENTIDAD ("waId", "phone") no se toca: es lo
-- que empareja los mensajes entrantes.
ALTER TABLE "Contact" ADD COLUMN "email" TEXT;
ALTER TABLE "Contact" ADD COLUMN "company" TEXT;
ALTER TABLE "Contact" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Contact_tenantId_company_idx" ON "Contact"("tenantId", "company");
CREATE INDEX "Contact_tenantId_ownerId_idx" ON "Contact"("tenantId", "ownerId");

-- Regla de alta automatica de tratos (feature 38). Apagada por defecto: una regla que
-- crea filas sola se enciende a mano.
ALTER TABLE "Tenant" ADD COLUMN "autoDealOnInbound" BOOLEAN NOT NULL DEFAULT false;

-- "Note" -> "Activity". La COPIA va antes del DROP, y conserva el "id" original: si algo
-- apuntaba a una nota, sigue apuntando. El "contactId" sale del JOIN con la conversacion
-- (Activity lo exige NOT NULL). "occurredAt" = "createdAt": una nota se escribio cuando
-- se escribio.
INSERT INTO "Activity" ("id", "tenantId", "type", "contactId", "conversationId", "authorId", "body", "occurredAt", "createdAt")
SELECT n."id", n."tenantId", 'note'::"ActivityType", c."contactId", n."conversationId", n."authorId", n."body", n."createdAt", n."createdAt"
FROM "Note" n
JOIN "Conversation" c ON c."id" = n."conversationId";

DROP TABLE "Note";
