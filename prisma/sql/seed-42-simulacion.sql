-- Grafo de prueba para firmar el `## Verificación` del contrato 42 (simulación en seco).
-- Idempotente.
--
--   docker exec -i whatsops-backend-postgres-1 psql -U whatsops -d whatsops \
--     -f - < prisma/sql/seed-42-simulacion.sql
--
-- SOLO DESARROLLO. Todo lleva el prefijo `seed42-` en el id, así que se retira entero con la
-- última consulta del archivo (comentada al final). No lo llama ningún código.
--
-- Nace en **borrador** a propósito: simular una automatización sin activarla es el caso
-- principal de la feature, y `runManual` no lo permite. Si este seed la dejara activa, la
-- verificación no probaría lo que dice que prueba.
--
-- El grafo cubre de una vez los diez puntos: un envío con las tres clases de variable, un
-- nodo de CRM, un cálculo de verdad, una espera larga, una espera de respuesta con sus dos
-- ramas y una llamada a una API.
--
--            trigger ─→ enviar ─→ trato ─→ calcular ─→ esperar 30 días ─→ esperar respuesta
--                                                                          │            │
--                                              «no contestó» ──→ recordar  │            │
--                                                     llamar a la API ←────┘  (contestó)
--                                                            │
--                                                          acusar
--
-- Y una segunda, `seed42-sinrama`, con un `wait.reply` que NO tiene rama de caducidad: es la
-- única forma de ver el segundo productor de `bloqueado`.

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_tenant text;
  v_admin  text;
  v_conv   text;
BEGIN
  -- El tenant real de desarrollo: el que tiene zona puesta y no es la plataforma.
  SELECT id INTO v_tenant
  FROM "Tenant" WHERE id <> 'platform' AND timezone IS NOT NULL
  ORDER BY "createdAt" LIMIT 1;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No hay ningún tenant con `timezone` puesta. Complétalo en el onboarding primero.';
  END IF;

  SELECT id INTO v_admin FROM "User" WHERE "tenantId" = v_tenant AND role = 'admin' LIMIT 1;

  -- La conversación con el ENTRANTE más reciente: así el punto 9 (la ventana de 24 h) se puede
  -- mirar en los dos sentidos. Si la última entrada es de hace más de un día, el efecto del
  -- envío tiene que llegar con `bloqueado`; si es de hoy, sin él.
  SELECT id INTO v_conv FROM "Conversation"
  WHERE "tenantId" = v_tenant ORDER BY "lastInboundAt" DESC NULLS LAST LIMIT 1;

  IF v_conv IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna conversación en el tenant %. Manda un mensaje primero.', v_tenant;
  END IF;

  DELETE FROM "Automation" WHERE id = 'seed42-auto';  -- nodos y aristas caen con ella

  INSERT INTO "Automation" (id, "tenantId", name, status, trigger, "actorUserId", "createdAt", "updatedAt")
  VALUES (
    'seed42-auto', v_tenant, '[seed42] Simulación en seco', 'draft',
    '{"type":"message.inbound","config":{}}'::jsonb, v_admin, now(), now()
  );

  INSERT INTO "AutomationNode" (id, "tenantId", "automationId", type, config, x, y, "isRoot", "createdAt", "updatedAt")
  VALUES
    ('seed42-n0', v_tenant, 'seed42-auto', 'message.inbound', '{}'::jsonb, 0, 0, true, now(), now()),

    -- Las TRES clases de variable en un solo texto, que es como se ven una al lado de la otra:
    --   `contacto.nombre` resuelve            → estado 'ok'
    --   `vars.total` no está puesta           → estado 'vacia', sale como nada
    --   `vars.mi campo` tiene un espacio      → estado 'inalcanzable', sale LITERAL con llaves
    ('seed42-n1', v_tenant, 'seed42-auto', 'message.send',
     '{"texto":"Hola {{contacto.nombre}}, total {{vars.total}} y {{vars.mi campo}}"}'::jsonb,
     240, 0, false, now(), now()),

    ('seed42-n2', v_tenant, 'seed42-auto', 'deal.create',
     '{"titulo":"[seed42] Venta de {{contacto.nombre}}"}'::jsonb, 480, 0, false, now(), now()),

    -- `code.run` SÍ se ejecuta de verdad en seco: es cómputo puro en un proceso hijo sin red,
    -- y ver qué calcula es justo el objetivo. 6*7 para que el 42 sea comprobable de un vistazo.
    ('seed42-n3', v_tenant, 'seed42-auto', 'code.run',
     '{"codigo":"return { respuesta: 6 * 7, quien: ctx.contacto.nombre };","guardarComo":"calc"}'::jsonb,
     720, 0, false, now(), now()),

    -- 30 días. En producción esto aparca el run un mes; en seco tiene que REPORTARSE y seguir.
    ('seed42-n4', v_tenant, 'seed42-auto', 'wait.delay', '{"minutos":43200}'::jsonb, 960, 0, false, now(), now()),

    ('seed42-n5', v_tenant, 'seed42-auto', 'wait.reply', '{"horas":24}'::jsonb, 1200, 0, false, now(), now()),

    -- Rama «contestó» (la arista sin nombre). La URL lleva una variable en la RUTA, no en el
    -- host: es la regla que el propio catálogo pide para no mandar el fetch a donde diga un dato.
    ('seed42-n6', v_tenant, 'seed42-auto', 'http.request',
     '{"url":"https://api.ejemplo.invalid/saldo/{{contacto.waId}}","metodo":"GET","guardarComo":"api"}'::jsonb,
     1440, -120, false, now(), now()),
    ('seed42-n7', v_tenant, 'seed42-auto', 'message.send',
     '{"texto":"Dijiste {{mensaje.texto}}. Tu saldo es {{vars.api.json.saldo}} y el cálculo dio {{vars.calc.respuesta}}."}'::jsonb,
     1680, -120, false, now(), now()),

    -- Rama de caducidad. Es la ÚNICA con nombre, y así es como la encuentran el motor y la
    -- simulación: por estructura, nunca comparando contra este literal.
    ('seed42-n8', v_tenant, 'seed42-auto', 'message.send',
     '{"texto":"No me contestaste, {{contacto.nombre}}. Te lo recuerdo."}'::jsonb,
     1440, 120, false, now(), now());

  INSERT INTO "AutomationEdge" (id, "tenantId", "automationId", "fromNodeId", "toNodeId", branch, "createdAt")
  VALUES
    ('seed42-e0', v_tenant, 'seed42-auto', 'seed42-n0', 'seed42-n1', NULL, now()),
    ('seed42-e1', v_tenant, 'seed42-auto', 'seed42-n1', 'seed42-n2', NULL, now()),
    ('seed42-e2', v_tenant, 'seed42-auto', 'seed42-n2', 'seed42-n3', NULL, now()),
    ('seed42-e3', v_tenant, 'seed42-auto', 'seed42-n3', 'seed42-n4', NULL, now()),
    ('seed42-e4', v_tenant, 'seed42-auto', 'seed42-n4', 'seed42-n5', NULL, now()),
    ('seed42-e5', v_tenant, 'seed42-auto', 'seed42-n5', 'seed42-n6', NULL, now()),
    ('seed42-e6', v_tenant, 'seed42-auto', 'seed42-n6', 'seed42-n7', NULL, now()),
    ('seed42-e7', v_tenant, 'seed42-auto', 'seed42-n5', 'seed42-n8', 'no contestó', now());

  -- --- Segunda automatización: un `wait.reply` SIN rama de caducidad --------------------
  -- Existe para poder ver el segundo —y único otro— productor de `bloqueado`. Con la de
  -- arriba no se puede: tiene las dos ramas, así que `respuestas: [null]` siempre encuentra a
  -- dónde seguir. Aquí no, y entonces el run REAL se cortaría: eso es lo que hay que ver
  -- llegar en rojo, porque es de las dos únicas cosas que en producción no irían como parecen.
  DELETE FROM "Automation" WHERE id = 'seed42-sinrama';

  INSERT INTO "Automation" (id, "tenantId", name, status, trigger, "actorUserId", "createdAt", "updatedAt")
  VALUES (
    'seed42-sinrama', v_tenant, '[seed42] Espera sin rama de caducidad', 'draft',
    '{"type":"message.inbound","config":{}}'::jsonb, v_admin, now(), now()
  );

  INSERT INTO "AutomationNode" (id, "tenantId", "automationId", type, config, x, y, "isRoot", "createdAt", "updatedAt")
  VALUES
    ('seed42-s0', v_tenant, 'seed42-sinrama', 'message.inbound', '{}'::jsonb, 0, 0, true, now(), now()),
    ('seed42-s1', v_tenant, 'seed42-sinrama', 'message.send',
     '{"texto":"¿Sigues ahí, {{contacto.nombre}}?"}'::jsonb, 240, 0, false, now(), now()),
    ('seed42-s2', v_tenant, 'seed42-sinrama', 'wait.reply', '{"horas":24}'::jsonb, 480, 0, false, now(), now()),
    ('seed42-s3', v_tenant, 'seed42-sinrama', 'message.send',
     '{"texto":"Gracias por contestar."}'::jsonb, 720, 0, false, now(), now());

  -- Solo la salida por defecto. NINGUNA arista con nombre: eso es lo que la hace distinta.
  INSERT INTO "AutomationEdge" (id, "tenantId", "automationId", "fromNodeId", "toNodeId", branch, "createdAt")
  VALUES
    ('seed42-f0', v_tenant, 'seed42-sinrama', 'seed42-s0', 'seed42-s1', NULL, now()),
    ('seed42-f1', v_tenant, 'seed42-sinrama', 'seed42-s1', 'seed42-s2', NULL, now()),
    ('seed42-f2', v_tenant, 'seed42-sinrama', 'seed42-s2', 'seed42-s3', NULL, now());

  RAISE NOTICE 'seed42 listo. tenant=% conversacion=% automatizaciones=seed42-auto, seed42-sinrama (las dos en borrador)', v_tenant, v_conv;
END $$;

-- Para retirarlo entero:
--   DELETE FROM "Automation" WHERE id IN ('seed42-auto', 'seed42-sinrama');
