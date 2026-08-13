import { Prisma } from '@prisma/client';

// Alcance del agente sobre los tratos. Calcado de `agentScope()` de
// `messaging/conversations.util.ts`, y a propósito: dos reglas de visibilidad con formas
// distintas en el mismo producto se contradicen a la primera pantalla que las cruza.
//
// Los tratos SIN DUEÑO entran, por lo mismo que `agentScope` deja ver las conversaciones
// abiertas: un trato que nadie ha reclamado tiene que ser visible para que alguien lo
// reclame. Si no, la regla de alta automática (feature 38) —que crea tratos con
// `ownerId: null`— llenaría un embudo que nadie ve.
//
// El admin no lleva restricción. `deals:manage` se comprueba en el guard, no aquí: este
// módulo decide QUÉ FILAS, el permiso decide QUÉ ACCIONES.
export function dealScope(role: string, userId: string): Prisma.DealWhereInput {
  if (role === 'admin') return {};
  return { OR: [{ ownerId: userId }, { ownerId: null }] };
}

// Where de un trato concreto con el alcance aplicado. Un id de otro tenant, o de un
// trato de otro vendedor, no da 403: da 404. Distinguirlos filtra la existencia del
// trato, que ya es información.
export function dealScopeWhere(
  tenantId: string,
  id: string,
  userId: string,
  role: string,
): Prisma.DealWhereInput {
  return { id, tenantId, ...dealScope(role, userId) };
}

// Alcance sobre las TAREAS, y no es el mismo: aquí no hay puerta para "las de nadie"
// porque `Task.assignedUserId` no es nulable — una tarea sin responsable no la hace
// nadie. Con `deals:manage` se ven todas, que es cómo el jefe de ventas sabe quién va
// atrasado; eso lo resuelve el controlador pasando `role: 'admin'`.
export function taskScope(role: string, userId: string): Prisma.TaskWhereInput {
  if (role === 'admin') return {};
  return { assignedUserId: userId };
}
