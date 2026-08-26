-- Ejecutar flujo (v11 feature 43): un run puede tener padre, y el historial de pasos deja de
-- borrarse cada vez que alguien guarda el grafo.
--
-- NOTA: escrita a mano y no con `migrate dev`, por el mismo motivo que las migraciones
-- 20260817180000, 20260819120000, 20260819170000 y 20260820200000: la shadow database no se
-- puede crear en este entorno y `migrate dev` proponía RESETEAR la base (ve como drift la tabla
-- `schema_embedding`, que crea prisma/sql/assistant-setup.sql y Prisma no conoce).
--
-- Aditiva y sin backfill: todo lo nuevo es nullable, y los runs que ya existen son todos de
-- primer nivel, que es exactamente lo que significa `parentRunId = NULL`.

-- AlterTable
ALTER TABLE "AutomationRun" ADD COLUMN "parentRunId"  TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "parentNodeId" TEXT;

-- CreateIndex
-- La IDEMPOTENCIA DE LA LLAMADA, hermana de `(runId, nodeId)`: un reintento del padre encuentra
-- el run del hijo en vez de crear otro, y por tanto no manda sus mensajes dos veces. En Postgres
-- dos NULL no colisionan, así que los runs de primer nivel no se estorban entre ellos — la misma
-- propiedad de la que ya vive `(tenantId, waitingConversationId)`.
CREATE UNIQUE INDEX "AutomationRun_parentRunId_parentNodeId_key"
  ON "AutomationRun"("parentRunId", "parentNodeId");

CREATE INDEX "AutomationRun_parentRunId_idx" ON "AutomationRun"("parentRunId");

-- Pendiente desde la 45, donde quedó marcado con su `ponytail:` y su techo. Esta es la feature
-- que multiplica las filas: cada llamada añade un run más.
CREATE INDEX "AutomationRun_tenantId_createdAt_idx" ON "AutomationRun"("tenantId", "createdAt");

-- AddForeignKey
-- Borrar A borra sus runs, y con ellos los sub-runs que A provocó en B. La alternativa
-- (`SET NULL`) dejaría huérfanos que la pantalla pinta como runs normales de B, y eso es peor
-- que no tenerlos: la evidencia «este mensaje salió porque A llamó a B», sin A, no prueba nada.
ALTER TABLE "AutomationRun"
  ADD CONSTRAINT "AutomationRun_parentRunId_fkey"
  FOREIGN KEY ("parentRunId") REFERENCES "AutomationRun"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- DropForeignKey
-- EL ARREGLO SILENCIOSO DE ESTA MIGRACIÓN, y no es de la 43: `AutomationRunStep.nodeId` tenía
-- una FK a `AutomationNode` con `ON DELETE CASCADE`, y `guardarGrafo` hace `deleteMany` de TODOS
-- los nodos en cada guardado. O sea que guardar el grafo **borraba los pasos de todas las
-- ejecuciones anteriores**, sin dar ningún error: el historial viejo simplemente aparecía vacío.
--
-- `nodeId` se queda como String pelado. El precio, declarado en `contrato/43`: un paso puede
-- apuntar a un nodo que ya no está en el grafo, y la pantalla tiene que decirlo en vez de dejar
-- el título en blanco. Perder el historial es mucho peor.
ALTER TABLE "AutomationRunStep" DROP CONSTRAINT "AutomationRunStep_nodeId_fkey";
