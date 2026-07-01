// Catálogo de permisos en CÓDIGO versionado (evita divergencia). Se siembra en
// DB (prisma/seed.ts). Las asignaciones rol→permiso sí son datos por tenant.
// Clave estable recurso:accion.
export const PERMISSIONS = [
  'conversations:read',
  'conversations:write',
  'waba:create',
  'templates:sync',
  'users:manage',
  'roles:manage',
  'billing:manage',
  'logs:read',
  'analytics:read',
] as const;
// nota: 'analytics:read' ya está en el catálogo (feature 07 lo consume).

export type PermissionKey = (typeof PERMISSIONS)[number];

// Permisos que recibe cada rol de sistema al sembrarse.
// admin = todos; agent = operar conversaciones.
export const SYSTEM_ROLE_PERMISSIONS: Record<'admin' | 'agent', PermissionKey[]> = {
  admin: [...PERMISSIONS],
  agent: ['conversations:read', 'conversations:write'],
};
