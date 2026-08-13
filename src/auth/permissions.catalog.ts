// Catálogo de permisos en CÓDIGO versionado (evita divergencia). Se siembra en
// DB (prisma/seed.ts). Las asignaciones rol→permiso sí son datos por tenant.
// Clave estable recurso:accion. Los metadatos (label/group/description) los
// consume la UI del constructor de roles (admin-v2 feature 01).

export interface PermissionMeta {
  key: string;
  label: string;
  group: string; // módulo, para agrupar la matriz en la UI
  description: string;
}

export const PERMISSION_CATALOG: PermissionMeta[] = [
  {
    key: 'conversations:read',
    label: 'Ver conversaciones',
    group: 'Conversaciones',
    description: 'Abrir la bandeja y leer conversaciones y mensajes.',
  },
  {
    key: 'conversations:write',
    label: 'Operar conversaciones',
    group: 'Conversaciones',
    description: 'Responder, asignar, cerrar y anotar conversaciones.',
  },
  {
    key: 'conversations:outbound',
    label: 'Iniciar conversaciones',
    group: 'Conversaciones',
    description:
      'Escribir a números que nunca nos han escrito, y envíos masivos. Los agentes contestan; prospectar es de admin.',
  },
  {
    key: 'contacts:read',
    label: 'Ver carteras de clientes',
    group: 'Contactos',
    description:
      'Ver las carteras a las que da acceso su rol, y los contactos que contienen.',
  },
  {
    key: 'contacts:manage',
    label: 'Gestionar carteras',
    group: 'Contactos',
    description:
      'Crear carteras, dar acceso por rol y dar de alta o baja contactos. Quién puede usar cada cartera se decide por rol en la cartera misma.',
  },
  // --- CRM (v8 feature 34) ---
  // El corte es el mismo que ya usan `contacts:read` / `contacts:manage`: OPERAR es de
  // agente, CONFIGURAR es de admin. Un vendedor que reordena las etapas le cambia el
  // proceso comercial al resto del equipo, y quien puede borrar tratos puede borrar el
  // histórico con el que se calculan las métricas.
  {
    key: 'deals:read',
    label: 'Ver el embudo',
    group: 'Embudo',
    description:
      'Abrir el tablero de tratos, las fichas de cliente y la agenda. Un agente ve los tratos suyos y los que no tienen dueño.',
  },
  {
    key: 'deals:write',
    label: 'Operar tratos',
    group: 'Embudo',
    description:
      'Crear tratos, editarlos, moverlos de etapa y cerrarlos como ganados o perdidos.',
  },
  {
    key: 'tasks:write',
    label: 'Operar tareas',
    group: 'Embudo',
    description: 'Crear tareas de seguimiento y completarlas anotando qué pasó.',
  },
  {
    key: 'deals:manage',
    label: 'Configurar el embudo',
    group: 'Embudo',
    description:
      'Crear y reordenar etapas y embudos, gestionar el catálogo de etiquetas, borrar tratos, ver y reasignar los de todo el equipo, y el alta automática de tratos.',
  },
  {
    key: 'waba:create',
    label: 'Gestionar conexiones',
    group: 'Conexiones',
    description: 'Conectar y eliminar números de WhatsApp del negocio.',
  },
  {
    key: 'templates:sync',
    label: 'Sincronizar plantillas',
    group: 'Plantillas',
    description: 'Importar y actualizar plantillas de mensajes desde Meta.',
  },
  {
    key: 'users:manage',
    label: 'Gestionar usuarios',
    group: 'Usuarios',
    description: 'Crear, editar, desactivar y borrar usuarios del negocio.',
  },
  {
    key: 'roles:manage',
    label: 'Gestionar roles',
    group: 'Roles',
    description: 'Crear roles personalizados y asignar permisos.',
  },
  {
    key: 'billing:manage',
    label: 'Gestionar facturación',
    group: 'Facturación',
    description: 'Métodos de pago, suscripción y facturación.',
  },
  {
    key: 'logs:read',
    label: 'Ver logs de errores',
    group: 'Observabilidad',
    description: 'Consultar el log core de errores de la API.',
  },
  {
    key: 'analytics:read',
    label: 'Ver métricas',
    group: 'Analítica',
    description: 'Dashboard y métricas de negocio.',
  },
];

// Solo las claves (compat con seed, guards y validación de roles).
export const PERMISSIONS = PERMISSION_CATALOG.map((p) => p.key) as [string, ...string[]];

export type PermissionKey = (typeof PERMISSION_CATALOG)[number]['key'];

// Permisos que recibe cada rol de sistema al sembrarse.
// admin = todos; agent = operar conversaciones.
//
// `conversations:outbound` queda FUERA de agent a propósito: escribir a desconocidos
// arriesga la reputación del número del negocio (y en la capa gratuita, la de la
// instancia compartida). Contestar es de agente; prospectar es de admin.
// `contacts:read` SÍ va en agent: ver a quién atiendes es parte de atender, y el acceso
// real lo sigue acotando el rol en cada cartera (una sin enlaces no la ve nadie salvo
// admin). `contacts:manage` no, por lo mismo que `conversations:outbound`: decidir a
// quién guardamos como cliente y a quién se le puede escribir es de admin.
//
// Del CRM (v8), `agent` recibe los tres de operar —`deals:read`, `deals:write` y
// `tasks:write`— porque vender ES el trabajo del agente: sin ellos el lote entero queda
// invisible para quien lo iba a usar todos los días. `deals:manage` no, por lo mismo que
// `contacts:manage`: configurar el proceso comercial y borrar histórico es de admin.
export const SYSTEM_ROLE_PERMISSIONS: Record<'admin' | 'agent', PermissionKey[]> = {
  admin: PERMISSION_CATALOG.map((p) => p.key),
  agent: [
    'conversations:read',
    'conversations:write',
    'contacts:read',
    'deals:read',
    'deals:write',
    'tasks:write',
  ],
};
