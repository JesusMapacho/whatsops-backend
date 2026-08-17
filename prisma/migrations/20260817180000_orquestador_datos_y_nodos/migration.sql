-- Orquestador de automatizaciones (v3 feature 17).
-- NOTA: generada con `prisma migrate diff` contra la base viva, no con `migrate dev`:
-- la shadow database no se puede crear en este entorno y `migrate dev` proponia RESETEAR
-- la base de desarrollo. Del diff se quito a mano un `DROP TABLE schema_embedding` -- esa
-- tabla la crea prisma/sql/assistant-setup.sql (pgvector) y Prisma no la conoce.

-- CreateEnum
CREATE TYPE "AutomationStatus" AS ENUM ('draft', 'active');

-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('running', 'waiting', 'done', 'failed');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('ok', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "Automation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "AutomationStatus" NOT NULL DEFAULT 'draft',
    "trigger" JSONB NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationNode" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "x" INTEGER NOT NULL DEFAULT 0,
    "y" INTEGER NOT NULL DEFAULT 0,
    "isRoot" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationEdge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    "branch" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "conversationId" TEXT,
    "status" "AutomationRunStatus" NOT NULL DEFAULT 'running',
    "context" JSONB NOT NULL DEFAULT '{}',
    "currentNodeId" TEXT,
    "error" TEXT,
    "activeConversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRunStep" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "status" "StepStatus" NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationRunStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Automation_tenantId_status_idx" ON "Automation"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Automation_tenantId_name_key" ON "Automation"("tenantId", "name");

-- CreateIndex
CREATE INDEX "AutomationNode_automationId_idx" ON "AutomationNode"("automationId");

-- CreateIndex
CREATE INDEX "AutomationNode_tenantId_idx" ON "AutomationNode"("tenantId");

-- CreateIndex
CREATE INDEX "AutomationEdge_automationId_idx" ON "AutomationEdge"("automationId");

-- CreateIndex
CREATE INDEX "AutomationEdge_tenantId_idx" ON "AutomationEdge"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationEdge_fromNodeId_branch_key" ON "AutomationEdge"("fromNodeId", "branch");

-- CreateIndex
CREATE INDEX "AutomationRun_tenantId_status_idx" ON "AutomationRun"("tenantId", "status");

-- CreateIndex
CREATE INDEX "AutomationRun_automationId_idx" ON "AutomationRun"("automationId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRun_tenantId_activeConversationId_key" ON "AutomationRun"("tenantId", "activeConversationId");

-- CreateIndex
CREATE INDEX "AutomationRunStep_runId_idx" ON "AutomationRunStep"("runId");

-- CreateIndex
CREATE INDEX "AutomationRunStep_tenantId_idx" ON "AutomationRunStep"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRunStep_runId_nodeId_key" ON "AutomationRunStep"("runId", "nodeId");

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationNode" ADD CONSTRAINT "AutomationNode_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationNode" ADD CONSTRAINT "AutomationNode_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationEdge" ADD CONSTRAINT "AutomationEdge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationEdge" ADD CONSTRAINT "AutomationEdge_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationEdge" ADD CONSTRAINT "AutomationEdge_fromNodeId_fkey" FOREIGN KEY ("fromNodeId") REFERENCES "AutomationNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationEdge" ADD CONSTRAINT "AutomationEdge_toNodeId_fkey" FOREIGN KEY ("toNodeId") REFERENCES "AutomationNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRunStep" ADD CONSTRAINT "AutomationRunStep_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRunStep" ADD CONSTRAINT "AutomationRunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRunStep" ADD CONSTRAINT "AutomationRunStep_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "AutomationNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;


