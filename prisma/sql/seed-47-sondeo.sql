-- Grafo de prueba para firmar el `## Verificación` del contrato 47 (sondeo y `campos`).
-- Idempotente.
--
--   docker exec -i whatsops-backend-postgres-1 psql -U whatsops -d whatsops \
--     -f - < prisma/sql/seed-47-sondeo.sql
--
-- SOLO DESARROLLO. Todo lleva el prefijo `seed47-` en el id; se retira con la consulta del
-- final. No lo llama ningún código.
--
-- Va aparte del `seed-42-simulacion.sql` a propósito: aquel está citado textualmente en la
-- verificación de la 42 —con los mensajes exactos que tienen que salir— y meterle un nodo
-- más invalidaría esas frases. Un fixture que sirve para dos features acaba sirviendo mal
-- para las dos.
--
--   trigger ─→ llamar a la API ─→ enviar «{{vars.saldo}} de {{vars.quien}}»
--
-- El nodo de la API lleva `campos`, que es la mitad de la feature: el envío de después NO
-- habla de `{{vars.api.json.data.0.saldo}}`, habla de `{{vars.saldo}}`. Esa es toda la
-- diferencia, y se ve en el texto del último paso.

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

  DELETE FROM "Automation" WHERE id = 'seed47-auto';

  INSERT INTO "Automation" (id, "tenantId", name, status, trigger, "actorUserId", "createdAt", "updatedAt")
  VALUES (
    'seed47-auto', v_tenant, '[seed47] Sondeo y campos con nombre', 'draft',
    '{"type":"message.inbound","config":{}}'::jsonb, v_admin, now(), now()
  );

  INSERT INTO "AutomationNode" (id, "tenantId", "automationId", type, config, x, y, "isRoot", "createdAt", "updatedAt")
  VALUES
    ('seed47-n0', v_tenant, 'seed47-auto', 'message.inbound', '{}'::jsonb, 0, 0, true, now(), now()),

    -- La URL lleva la variable en la RUTA y no en el host, que es lo que pide el propio
    -- catálogo. El host es `.invalid` (RFC 2606): no resuelve nunca, así que sondear esto de
    -- verdad falla a propósito y enseña el camino de error sin depender de una API ajena.
    ('seed47-n1', v_tenant, 'seed47-auto', 'http.request',
     ('{"url":"https://api.ejemplo.invalid/cuenta/{{contacto.waId}}","metodo":"GET",'
      || '"guardarComo":"api",'
      || '"campos":[{"nombre":"saldo","ruta":"vars.api.json.data.0.saldo"},'
      || '{"nombre":"quien","ruta":"vars.api.json.cliente.nombre"}]}')::jsonb,
     240, 0, false, now(), now()),

    -- Aquí está la feature entera: este texto NO menciona la forma de la API.
    ('seed47-n2', v_tenant, 'seed47-auto', 'message.send',
     '{"texto":"Tu saldo es {{vars.saldo}}, {{vars.quien}}."}'::jsonb,
     480, 0, false, now(), now());

  INSERT INTO "AutomationEdge" (id, "tenantId", "automationId", "fromNodeId", "toNodeId", branch, "createdAt")
  VALUES
    ('seed47-g0', v_tenant, 'seed47-auto', 'seed47-n0', 'seed47-n1', NULL, now()),
    ('seed47-g1', v_tenant, 'seed47-auto', 'seed47-n1', 'seed47-n2', NULL, now());

  RAISE NOTICE 'seed47 listo. tenant=% automatizacion=seed47-auto (borrador)', v_tenant;
END $$;

-- Para retirarlo:
--   DELETE FROM "Automation" WHERE id = 'seed47-auto';
