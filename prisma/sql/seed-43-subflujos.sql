-- Grafos de prueba para firmar el `## Verificación` del contrato 43 (ejecutar flujo).
-- Idempotente.
--
--   docker exec -i whatsops-backend-postgres-1 psql -U whatsops -d whatsops \
--     -f - < prisma/sql/seed-43-subflujos.sql
--
-- SOLO DESARROLLO. Todo lleva el prefijo `seed43-`; se retira con la consulta del final.
--
-- Cuatro automatizaciones, y cada una existe para un punto de la verificación que las otras no
-- pueden provocar:
--
--   seed43-padre   ─→ llama a `seed43-hijo` y usa su resultado.        (puntos 1, 2)
--   seed43-hijo    ─→ el procedimiento: recibe `quien`, deja `eco`.
--   seed43-espera  ─→ un sub-flujo con un `wait.reply` dentro.         (punto 6)
--   seed43-ciclo   ─→ se llama a sí misma.                             (punto 5)
--
-- El padre nace ACTIVO y el hijo también, porque un sub-flujo en borrador no se puede llamar y
-- ese es justo uno de los motivos que `/llamables` tiene que saber decir. Las otras dos nacen en
-- borrador **a propósito**: activarlas es lo que tiene que fallar.

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_tenant text;
  v_admin  text;
BEGIN
  SELECT id INTO v_tenant
  FROM "Tenant" WHERE id <> 'platform' AND timezone IS NOT NULL
  ORDER BY "createdAt" LIMIT 1;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No hay ningún tenant con `timezone` puesta. Complétalo en el onboarding primero.';
  END IF;

  SELECT id INTO v_admin FROM "User" WHERE "tenantId" = v_tenant AND role = 'admin' LIMIT 1;

  DELETE FROM "Automation" WHERE id IN ('seed43-padre', 'seed43-hijo', 'seed43-espera', 'seed43-ciclo');

  -- --- El hijo: un procedimiento. Recibe `quien` y deja `eco`. -----------------------------
  INSERT INTO "Automation" (id, "tenantId", name, status, trigger, "actorUserId", "createdAt", "updatedAt")
  VALUES ('seed43-hijo', v_tenant, '[seed43] Saludo reutilizable', 'active',
          '{"type":"manual","config":{}}'::jsonb, v_admin, now(), now());

  INSERT INTO "AutomationNode" (id, "tenantId", "automationId", type, config, x, y, "isRoot", "createdAt", "updatedAt")
  VALUES
    ('seed43-h0', v_tenant, 'seed43-hijo', 'manual', '{}'::jsonb, 0, 0, true, now(), now()),
    -- Lee `{{vars.quien}}`, que NO hereda del padre: se lo pasan por `argumentos`. Si el hijo
    -- heredara las vars del padre, lo que hace dependería de quién lo llama.
    ('seed43-h1', v_tenant, 'seed43-hijo', 'var.set',
     '{"guardarComo":"eco","valor":"Hola {{vars.quien}}, soy el sub-flujo"}'::jsonb, 240, 0, false, now(), now());

  INSERT INTO "AutomationEdge" (id, "tenantId", "automationId", "fromNodeId", "toNodeId", branch, "createdAt")
  VALUES ('seed43-he0', v_tenant, 'seed43-hijo', 'seed43-h0', 'seed43-h1', NULL, now());

  -- --- El padre: llama, y usa lo que el hijo devolvió --------------------------------------
  INSERT INTO "Automation" (id, "tenantId", name, status, trigger, "actorUserId", "createdAt", "updatedAt")
  VALUES ('seed43-padre', v_tenant, '[seed43] Llama al saludo', 'active',
          '{"type":"message.inbound","config":{}}'::jsonb, v_admin, now(), now());

  INSERT INTO "AutomationNode" (id, "tenantId", "automationId", type, config, x, y, "isRoot", "createdAt", "updatedAt")
  VALUES
    ('seed43-p0', v_tenant, 'seed43-padre', 'message.inbound', '{}'::jsonb, 0, 0, true, now(), now()),
    ('seed43-p1', v_tenant, 'seed43-padre', 'automation.run',
     ('{"automationId":"seed43-hijo","guardarComo":"sub",'
      || '"argumentos":[{"nombre":"quien","ruta":"contacto.nombre"}]}')::jsonb,
     240, 0, false, now(), now()),
    -- AQUÍ está la feature: `{{vars.sub.eco}}` y no `{{vars.sub.vars.eco}}`. Con el sobre, el
    -- aplanado del editor (profundidad 3) no llegaría al dato y desaparecería del
    -- autocompletado. El argumento medido, en `contrato/43 §1`.
    ('seed43-p2', v_tenant, 'seed43-padre', 'message.send',
     '{"texto":"El flujo llamado dijo: {{vars.sub.eco}}"}'::jsonb, 480, 0, false, now(), now());

  INSERT INTO "AutomationEdge" (id, "tenantId", "automationId", "fromNodeId", "toNodeId", branch, "createdAt")
  VALUES
    ('seed43-pe0', v_tenant, 'seed43-padre', 'seed43-p0', 'seed43-p1', NULL, now()),
    ('seed43-pe1', v_tenant, 'seed43-padre', 'seed43-p1', 'seed43-p2', NULL, now());

  -- --- Un sub-flujo que espera. En borrador: activarlo es lo que se prueba. ----------------
  -- Es el caso que las guardas estáticas NO cubren solas: se activa esta, y entonces el padre
  -- —que ya estaba activo— apunta a un flujo que espera. Solo la guarda de ejecución lo para.
  INSERT INTO "Automation" (id, "tenantId", name, status, trigger, "actorUserId", "createdAt", "updatedAt")
  VALUES ('seed43-espera', v_tenant, '[seed43] Sub-flujo que espera', 'draft',
          '{"type":"manual","config":{}}'::jsonb, v_admin, now(), now());

  INSERT INTO "AutomationNode" (id, "tenantId", "automationId", type, config, x, y, "isRoot", "createdAt", "updatedAt")
  VALUES
    ('seed43-e0', v_tenant, 'seed43-espera', 'manual', '{}'::jsonb, 0, 0, true, now(), now()),
    ('seed43-e1', v_tenant, 'seed43-espera', 'wait.reply', '{"horas":24}'::jsonb, 240, 0, false, now(), now()),
    ('seed43-e2', v_tenant, 'seed43-espera', 'message.send', '{"texto":"gracias"}'::jsonb, 480, 0, false, now(), now());

  INSERT INTO "AutomationEdge" (id, "tenantId", "automationId", "fromNodeId", "toNodeId", branch, "createdAt")
  VALUES
    ('seed43-ee0', v_tenant, 'seed43-espera', 'seed43-e0', 'seed43-e1', NULL, now()),
    ('seed43-ee1', v_tenant, 'seed43-espera', 'seed43-e1', 'seed43-e2', NULL, now());

  -- --- La que se llama a sí misma. Activarla tiene que fallar con un mensaje que lo diga. --
  INSERT INTO "Automation" (id, "tenantId", name, status, trigger, "actorUserId", "createdAt", "updatedAt")
  VALUES ('seed43-ciclo', v_tenant, '[seed43] Se llama a sí misma', 'draft',
          '{"type":"manual","config":{}}'::jsonb, v_admin, now(), now());

  INSERT INTO "AutomationNode" (id, "tenantId", "automationId", type, config, x, y, "isRoot", "createdAt", "updatedAt")
  VALUES
    ('seed43-c0', v_tenant, 'seed43-ciclo', 'manual', '{}'::jsonb, 0, 0, true, now(), now()),
    ('seed43-c1', v_tenant, 'seed43-ciclo', 'automation.run',
     '{"automationId":"seed43-ciclo","guardarComo":"yo"}'::jsonb, 240, 0, false, now(), now());

  INSERT INTO "AutomationEdge" (id, "tenantId", "automationId", "fromNodeId", "toNodeId", branch, "createdAt")
  VALUES ('seed43-ce0', v_tenant, 'seed43-ciclo', 'seed43-c0', 'seed43-c1', NULL, now());

  RAISE NOTICE 'seed43 listo. tenant=% padre=seed43-padre (activo) hijo=seed43-hijo (activo) espera/ciclo (borrador)', v_tenant;
END $$;

-- Para retirarlo:
--   DELETE FROM "Automation" WHERE id IN ('seed43-padre','seed43-hijo','seed43-espera','seed43-ciclo');
