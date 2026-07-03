-- Setup a nivel BD para el asistente v1.5 (Rama B). Idempotente.
-- Correr una vez con un rol con privilegios (owner/superuser):
--   psql "$DATABASE_URL" -f prisma/sql/assistant-setup.sql
-- No lo maneja `prisma db push` (extensión, índice HNSW, rol y RLS son DDL fuera del schema).

-- 1) pgvector + tabla de embeddings del ESQUEMA documentado (nunca datos de tenants).
CREATE EXTENSION IF NOT EXISTS vector;

-- dim 1536 = text-embedding-3-small (OpenAI). Si cambias de modelo de embeddings,
-- ajusta la dimensión y reindexa (el índice HNSW fija la dimensión).
CREATE TABLE IF NOT EXISTS schema_embedding (
  id        text PRIMARY KEY,
  content   text NOT NULL,
  metadata  jsonb NOT NULL DEFAULT '{}',
  embedding vector(1536)
);
CREATE INDEX IF NOT EXISTS schema_embedding_hnsw
  ON schema_embedding USING hnsw (embedding vector_cosine_ops);

-- 2) Rol read-only dedicado. Se crea SIN login; el operador le pone contraseña y la
--    referencia en DATABASE_URL_RO (secreto, fuera de este archivo):
--      ALTER ROLE whatsops_ro WITH LOGIN PASSWORD 'xxxxx';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'whatsops_ro') THEN
    CREATE ROLE whatsops_ro NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO whatsops_ro;
-- SELECT solo sobre las tablas consultables (debe coincidir con ALLOWED_TABLES del sql-guard).
GRANT SELECT ON
  "Conversation", "Message", "Contact", "Note", "Template", "CannedResponse"
  TO whatsops_ro;
-- WabaConnection: SELECT a nivel COLUMNA, excluyendo "accessTokenEnc" (token cifrado, secreto).
-- Si el SQL pide esa columna, el rol RO recibe "permission denied" (falla cerrado).
GRANT SELECT ("id", "tenantId", "wabaId", "phoneNumberId", "businessId", "source", "status", "createdAt", "updatedAt")
  ON "WabaConnection" TO whatsops_ro;

-- 3) RLS por tenant. El rol RO no es owner → las políticas SÍ le aplican (el owner las
--    bypassa, por eso el resto de la app sigue con su filtrado a nivel código sin cambios).
--    app.tenant_id lo fija el ejecutor con SET LOCAL (viene del JWT, nunca del LLM).
--    current_setting(..., true): si no está seteado devuelve NULL → la política no deja ver nada.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Conversation','Message','Contact','Note','Template','CannedResponse','WabaConnection']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR SELECT TO whatsops_ro
         USING ("tenantId" = current_setting(''app.tenant_id'', true))', t);
  END LOOP;
END $$;
