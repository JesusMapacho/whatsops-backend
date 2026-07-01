import { SetMetadata } from '@nestjs/common';
import { PermissionKey } from './permissions.catalog';

export const PERMISSIONS_KEY = 'permissions';
// Exige TODOS los permisos listados. Se resuelven desde el rol del usuario en DB.
export const RequirePermissions = (...perms: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_KEY, perms);
