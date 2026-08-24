-- Datos de prueba para juzgar la pantalla de la 46 (agenda de tareas). Idempotente.
--
--   docker exec -i whatsops-backend-postgres-1 psql -U whatsops -d whatsops \
--     -f - < prisma/sql/seed-46-agenda.sql
--
-- SOLO DESARROLLO. Todo lo que crea lleva el prefijo `seed46-` en el id, así que se retira
-- entero con la última consulta de este archivo (comentada al final). No lo llama ningún
-- código: existe para poder firmar el `## Verificación` de `spec/46-agenda-de-tareas.md`
-- sin inventarse los casos límite a mano cada vez.
--
-- Las fechas se derivan de `now()` EN LA ZONA DEL TENANT, no del servidor: es justo lo que
-- hay que poder ver (una tarea de hoy a las 09:00 sigue en «Hoy» por la tarde). Por eso el
-- archivo no lleva ni una fecha literal — corrido dentro de un mes sigue significando lo
-- mismo.

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_tenant   text;
  v_zona     text;
  v_admin    text;
  v_agente   text := 'seed46-user-agente';
  v_contacto text;
  v_trato    text := 'seed46-deal';
  v_etapa    text;
  v_pipeline text;
  v_rol      text;
  -- Medianoche de HOY en la zona del negocio, como instante UTC. Todo cuelga de aquí.
  v_hoy      timestamp;
BEGIN
  -- El tenant real de desarrollo: el que tiene zona puesta y no es la plataforma.
  SELECT id, COALESCE(timezone, 'UTC') INTO v_tenant, v_zona
  FROM "Tenant" WHERE id <> 'platform' AND timezone IS NOT NULL
  ORDER BY "createdAt" LIMIT 1;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No hay ningún tenant con `timezone` puesta. Complétalo en el onboarding primero.';
  END IF;

  SELECT id INTO v_admin FROM "User" WHERE "tenantId" = v_tenant AND role = 'admin' LIMIT 1;
  SELECT id INTO v_contacto FROM "Contact" WHERE "tenantId" = v_tenant ORDER BY "createdAt" LIMIT 1;
  SELECT s.id INTO v_etapa FROM "Stage" s
    JOIN "Pipeline" p ON p.id = s."pipelineId"
    WHERE p."tenantId" = v_tenant ORDER BY s."position" LIMIT 1;
  SELECT s."pipelineId" INTO v_pipeline FROM "Stage" s WHERE s.id = v_etapa;

  -- El rol de fila, NO el enum: `permissionKeysFor` devuelve [] para un no-admin sin
  -- `roleId`, así que un usuario con role='agent' y roleId nulo no puede ni leer. El enum
  -- `User.role` decide el alcance por filas; los permisos salen del `Role`.
  SELECT id INTO v_rol FROM "Role" WHERE "tenantId" = v_tenant AND name = 'agent' LIMIT 1;

  IF v_admin IS NULL OR v_contacto IS NULL OR v_etapa IS NULL OR v_rol IS NULL THEN
    RAISE EXCEPTION 'Falta admin, contacto o etapa en el tenant %', v_tenant;
  END IF;

  v_hoy := (date_trunc('day', now() AT TIME ZONE v_zona) AT TIME ZONE v_zona) AT TIME ZONE 'UTC';
  RAISE NOTICE 'tenant=% zona=% medianoche_utc=%', v_tenant, v_zona, v_hoy;

  -- ---------------------------------------------------------------------------------
  -- El SEGUNDO usuario, para que «Del equipo» enseñe algo distinto de «Mías».
  --
  -- Rol `agent`: NO tiene `deals:manage`, que es exactamente lo que lo hace útil como
  -- contraste, y de paso es con quien se comprueba que el alcance por filas aguanta.
  --
  -- ATENCIÓN: contraseña de desarrollo, fija y pública en este archivo (`agenda46local`).
  -- Es un usuario de juguete en una base local. NO subas esta base a ningún sitio, y borra
  -- el usuario con la consulta del final cuando termines de mirar la pantalla.
  -- ---------------------------------------------------------------------------------
  INSERT INTO "User" (id, "tenantId", email, "passwordHash", role, "firstName", "lastName",
                      status, "emailVerified", "isPlatform", "roleId", "createdAt", "updatedAt")
  VALUES (v_agente, v_tenant, 'qa.agente@cma.test',
          '$2b$10$RZLiyc.ug4IHPfk.Og8yYeQ9YBzLG94AxA5MFi92uDVkbbSmzlqI6',
          'agent', 'Ana', 'Quiroga', 'active', true, false, v_rol, now(), now())
  ON CONFLICT (id) DO NOTHING;
  UPDATE "User" SET "roleId" = v_rol WHERE id = v_agente;

  -- Un trato CON importe, para la píldora «Título · 4.200».
  INSERT INTO "Deal" (id, "tenantId", title, amount, "contactId", "pipelineId", "stageId",
                      "ownerId", status, "createdAt", "updatedAt")
  VALUES (v_trato, v_tenant, 'Reposición Q3', 4200.00, v_contacto, v_pipeline, v_etapa,
          v_admin, 'open', now(), now())
  ON CONFLICT (id) DO UPDATE SET amount = EXCLUDED.amount, title = EXCLUDED.title;

  -- ---------------------------------------------------------------------------------
  -- Las tareas. `dueAt` se compone desde la medianoche del negocio, así que las horas de
  -- abajo son horas de PARED del tenant.
  -- ---------------------------------------------------------------------------------
  -- Las actividades que cuelgan de las tareas sembradas van PRIMERO: `Activity.taskId` es
  -- `onDelete: SetNull`, así que borrar la tarea antes dejaría la entrada suelta en el
  -- timeline. Esto barre además las que deje una prueba a mano (cerrar y reabrir escribe una
  -- `task_done` nueva cada vez, que es la consecuencia declarada en el contrato §2).
  DELETE FROM "Activity" WHERE "taskId" LIKE 'seed46-task-%';
  DELETE FROM "Task" WHERE id LIKE 'seed46-task-%';

  INSERT INTO "Task" (id, "tenantId", title, type, "dueAt", "assignedUserId", "contactId",
                      "dealId", "completedAt", outcome, "createdById", "createdAt", "updatedAt")
  VALUES
    -- ATRASADAS. La de -3 días da la píldora «3 DÍAS TARDE»; la de -1 el singular.
    ('seed46-task-atr3', v_tenant, 'Llamar a Sergio por la reposición', 'call',
     v_hoy - interval '3 day' + interval '10 hour', v_admin, v_contacto, v_trato,
     NULL, NULL, v_admin, now(), now()),
    ('seed46-task-atr1', v_tenant, 'Mandar cotización pendiente', 'email',
     v_hoy - interval '1 day' + interval '11 hour', v_agente, v_contacto, NULL,
     NULL, NULL, v_admin, now(), now()),

    -- HOY a las 09:00. EL CASO: por la tarde tiene que seguir en «Hoy», no en «Atrasadas».
    ('seed46-task-hoy09', v_tenant, 'Revisar la agenda del día', 'other',
     v_hoy + interval '9 hour', v_admin, v_contacto, NULL,
     NULL, NULL, v_admin, now(), now()),
    -- HOY con hora rara: con ésta se comprueba que aplazar CONSERVA la hora (16:15) y no
    -- la manda a las 09:00.
    ('seed46-task-hoy1615', v_tenant, 'Videollamada de cierre', 'meeting',
     v_hoy + interval '16 hour' + interval '15 minute', v_agente, v_contacto, v_trato,
     NULL, NULL, v_admin, now(), now()),
    -- Una de hoy SIN CONTACTO: la interna. Al cerrarla no deja rastro en ningún timeline,
    -- y la pantalla lo avisa.
    ('seed46-task-interna', v_tenant, 'Cuadrar caja de la semana', 'other',
     v_hoy + interval '12 hour', v_admin, NULL, NULL,
     NULL, NULL, v_admin, now(), now()),
    -- De hoy pero de LA OTRA PERSONA: con «Mías» no sale, con «Del equipo» sí.
    ('seed46-task-otro', v_tenant, 'Contestar a Dieand', 'whatsapp',
     v_hoy + interval '13 hour', v_agente, v_contacto, NULL,
     NULL, NULL, v_admin, now(), now()),

    -- PRÓXIMAS. La de +9 cuenta en el cubo pero NO en «Esta semana» (6 días).
    ('seed46-task-mas1', v_tenant, 'Seguimiento de la propuesta', 'call',
     v_hoy + interval '1 day' + interval '9 hour', v_admin, v_contacto, v_trato,
     NULL, NULL, v_admin, now(), now()),
    ('seed46-task-mas2', v_tenant, 'Preparar material de la demo', 'other',
     v_hoy + interval '2 day' + interval '9 hour', v_agente, v_contacto, NULL,
     NULL, NULL, v_admin, now(), now()),
    ('seed46-task-mas9', v_tenant, 'Revisión mensual de cuenta', 'meeting',
     v_hoy + interval '9 day' + interval '9 hour', v_admin, v_contacto, NULL,
     NULL, NULL, v_admin, now(), now()),

    -- CREADA POR EL SISTEMA: `createdById` nulo. La otra cara de «Creada por».
    ('seed46-task-auto', v_tenant, 'Primer contacto (automática)', 'whatsapp',
     v_hoy + interval '3 day' + interval '9 hour', v_admin, v_contacto, v_trato,
     NULL, NULL, NULL, now(), now()),

    -- CERRADAS. La de hace 9 días tiene que quedar FUERA del cubo Hechas y de «Cerradas 7 d»:
    -- es el recorte del que habla el contrato.
    ('seed46-task-cer2', v_tenant, 'Llamada de descubrimiento', 'call',
     v_hoy - interval '2 day' + interval '10 hour', v_admin, v_contacto, v_trato,
     v_hoy - interval '2 day' + interval '11 hour', 'No contestó, vuelvo el jueves',
     v_admin, now(), now()),
    ('seed46-task-cer6', v_tenant, 'Enviar ficha técnica', 'email',
     v_hoy - interval '6 day' + interval '10 hour', v_agente, v_contacto, NULL,
     v_hoy - interval '6 day' + interval '15 hour', 'Enviada', v_admin, now(), now()),
    ('seed46-task-cer9', v_tenant, 'Reunión inicial', 'meeting',
     v_hoy - interval '9 day' + interval '10 hour', v_agente, v_contacto, NULL,
     v_hoy - interval '9 day' + interval '12 hour', 'Fuera de la ventana de 7 días',
     v_admin, now(), now());

  -- ---------------------------------------------------------------------------------
  -- Timeline del contacto, para que el panel de detalle no salga vacío.
  -- `task_done` de las cerradas incluido: es la entrada que SOBREVIVE a reabrir, y es lo
  -- que hay que poder mirar después de darle al botón.
  -- ---------------------------------------------------------------------------------
  DELETE FROM "Activity" WHERE id LIKE 'seed46-act-%';

  INSERT INTO "Activity" (id, "tenantId", type, "contactId", "dealId", "taskId", "authorId",
                          body, "occurredAt", "createdAt")
  VALUES
    ('seed46-act-1', v_tenant, 'deal_created', v_contacto, v_trato, NULL, v_admin,
     NULL, v_hoy - interval '12 day', now()),
    ('seed46-act-2', v_tenant, 'note', v_contacto, NULL, NULL, v_admin,
     'Pidió precios por volumen. Le interesa cerrar antes de fin de trimestre.',
     v_hoy - interval '10 day', now()),
    ('seed46-act-3', v_tenant, 'task_done', v_contacto, NULL, 'seed46-task-cer9', v_admin,
     'Fuera de la ventana de 7 días', v_hoy - interval '9 day' + interval '12 hour', now()),
    ('seed46-act-4', v_tenant, 'call', v_contacto, v_trato, NULL, v_admin,
     'Llamada de 12 minutos, quedó en revisarlo con su socio.',
     v_hoy - interval '7 day', now()),
    ('seed46-act-5', v_tenant, 'task_done', v_contacto, NULL, 'seed46-task-cer6', v_admin,
     'Enviada', v_hoy - interval '6 day' + interval '15 hour', now()),
    ('seed46-act-6', v_tenant, 'task_done', v_contacto, v_trato, 'seed46-task-cer2', v_admin,
     'No contestó, vuelvo el jueves', v_hoy - interval '2 day' + interval '11 hour', now());

  RAISE NOTICE 'Sembradas 13 tareas, 1 trato, 6 actividades y el usuario qa.agente@cma.test';
END $$;

-- Para retirarlo todo:
--   DELETE FROM "Activity" WHERE id LIKE 'seed46-act-%' OR "taskId" LIKE 'seed46-task-%';
--   DELETE FROM "Task"     WHERE id LIKE 'seed46-task-%';
--   DELETE FROM "Deal"     WHERE id = 'seed46-deal';
--   DELETE FROM "User"     WHERE id = 'seed46-user-agente';
