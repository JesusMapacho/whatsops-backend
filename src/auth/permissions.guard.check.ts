// Check del guard de permisos. Correr: npx ts-node src/auth/permissions.guard.check.ts
import * as assert from 'node:assert';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { PrismaService } from '../prisma/prisma.service';
import { SYSTEM_ROLE_PERMISSIONS } from './permissions.catalog';

// Fakes mínimos.
function reflectorReturning(perms: string[] | undefined): Reflector {
  return { getAllAndOverride: () => perms } as unknown as Reflector;
}

function prismaWithPerms(keys: string[]): PrismaService {
  return {
    rolePermission: {
      findMany: async () => keys.map((key) => ({ permission: { key } })),
    },
    user: { findUnique: async () => ({ roleId: 'r1' }) },
  } as unknown as PrismaService;
}

function ctx(user: any) {
  return {
    getHandler: () => null,
    getClass: () => null,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as any;
}

async function run() {
  // Sin permisos requeridos → pasa.
  let g = new PermissionsGuard(reflectorReturning(undefined), prismaWithPerms([]));
  assert.strictEqual(await g.canActivate(ctx({ role: 'agent', roleId: 'r1' })), true);

  // admin de sistema → pasa aunque no tenga el permiso en DB.
  g = new PermissionsGuard(reflectorReturning(['users:manage']), prismaWithPerms([]));
  assert.strictEqual(await g.canActivate(ctx({ role: 'admin', roleId: null })), true);

  // agent con el permiso → pasa.
  g = new PermissionsGuard(
    reflectorReturning(['conversations:write']),
    prismaWithPerms(['conversations:read', 'conversations:write']),
  );
  assert.strictEqual(await g.canActivate(ctx({ role: 'agent', roleId: 'r1' })), true);

  // agent sin el permiso → 403.
  g = new PermissionsGuard(
    reflectorReturning(['users:manage']),
    prismaWithPerms(['conversations:read', 'conversations:write']),
  );
  await assert.rejects(() => g.canActivate(ctx({ role: 'agent', roleId: 'r1' })));

  // exige TODOS: tiene uno pero no el otro → 403.
  g = new PermissionsGuard(
    reflectorReturning(['conversations:write', 'users:manage']),
    prismaWithPerms(['conversations:write']),
  );
  await assert.rejects(() => g.canActivate(ctx({ role: 'agent', roleId: 'r1' })));

  // El rol `agent` NO trae `conversations:outbound` de fábrica: contestar es de
  // agente, prospectar es de admin. Si alguien lo mete en la lista de sistema, todos
  // los agentes de todos los tenants pueden escribirle a desconocidos en el próximo
  // arranque (ensureSystemRoles se ejecuta en onModuleInit y solo AGREGA permisos).
  assert.ok(!SYSTEM_ROLE_PERMISSIONS.agent.includes('conversations:outbound'));
  assert.ok(SYSTEM_ROLE_PERMISSIONS.admin.includes('conversations:outbound'));
  // Y sigue siendo un permiso, no un chequeo de rol suelto: un rol a medida que no
  // lo tenga recibe 403 aunque pueda operar conversaciones.
  g = new PermissionsGuard(
    reflectorReturning(['conversations:outbound']),
    prismaWithPerms(['conversations:read', 'conversations:write']),
  );
  await assert.rejects(() => g.canActivate(ctx({ role: 'agent', roleId: 'r1' })));

  // CRM (v8): el agente SÍ opera el embudo —vender es su trabajo, y sin estos tres el
  // lote queda invisible para quien lo iba a usar— pero NO lo configura. Si `deals:manage`
  // entrara en la lista de sistema, en el próximo arranque todos los agentes de todos los
  // tenants podrían reordenar etapas y borrar tratos (ensureSystemRoles solo AGREGA).
  for (const k of ['deals:read', 'deals:write', 'tasks:write'] as const) {
    assert.ok(SYSTEM_ROLE_PERMISSIONS.agent.includes(k), `agent debe traer ${k}`);
  }
  assert.ok(!SYSTEM_ROLE_PERMISSIONS.agent.includes('deals:manage'));
  assert.ok(SYSTEM_ROLE_PERMISSIONS.admin.includes('deals:manage'));
  // Y configurar el embudo es un permiso, no un chequeo de rol: quien puede operar tratos
  // sigue recibiendo 403 al tocar la configuración.
  g = new PermissionsGuard(
    reflectorReturning(['deals:manage']),
    prismaWithPerms(['deals:read', 'deals:write', 'tasks:write']),
  );
  await assert.rejects(() => g.canActivate(ctx({ role: 'agent', roleId: 'r1' })));

  console.log('permissions.guard.check OK');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
