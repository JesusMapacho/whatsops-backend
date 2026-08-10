// ¿Quién puede ver, usar y gestionar cada cartera de clientes? Puro: sin Nest ni DB,
// los enlaces se inyectan → testeable en access.check.ts.
//
// El control es por CARTERA y por ROL, no por contacto ni por usuario:
//   · Por cartera, porque "quién ve qué contactos" sale transitivamente (ves los
//     contactos de las carteras a las que tienes acceso) y un ACL por contacto es una
//     matriz que nadie mantiene.
//   · Por rol, porque así no hay que tocar accesos cada vez que entra o sale alguien
//     del equipo. El precio, dicho: "esta cartera es solo de Ana" exige un rol propio.

// Enlace cartera→rol tal como está en DB (`ContactListRole`).
export interface ListRoleLink {
  contactListId: string;
  roleId: string;
  // Además de usar la cartera, puede editarla y dar de alta/baja miembros.
  canManage: boolean;
}

export interface Actor {
  // Rol de sistema del enum (`admin` | `agent`), no el rol a medida.
  role: string;
  // Rol a medida del usuario. null si nunca se le asignó uno.
  roleId: string | null;
}

// El admin de sistema pasa por encima de los enlaces, igual que en
// `PermissionsGuard.canActivate` y `RolesService.permissionKeysFor`. Si esto no
// coincidiera con el guard, un admin vería el botón y recibiría un 403.
function isAdmin(actor: Actor): boolean {
  return actor.role === 'admin';
}

// Carteras que este actor puede USAR (verlas, y enviar a sus miembros).
//
// `links` son los enlaces de las carteras candidatas, YA acotadas por tenant en la
// query: esta función no sabe de tenants y no debe decidir sobre ellos.
export function usableListIds(actor: Actor, links: ListRoleLink[]): Set<string> {
  const out = new Set<string>();
  for (const l of links) {
    if (isAdmin(actor) || (actor.roleId && l.roleId === actor.roleId)) {
      out.add(l.contactListId);
    }
  }
  return out;
}

// ¿Puede usar ESTA cartera?
//
// Una cartera SIN ningún enlace es solo de admin. Es un default CERRADO a propósito:
// una cartera recién creada no debe quedar expuesta al tenant entero mientras su dueño
// todavía no ha decidido con quién compartirla. Y ahorra sembrar accesos al crearla.
export function canUseList(actor: Actor, listId: string, links: ListRoleLink[]): boolean {
  if (isAdmin(actor)) return true;
  return links.some((l) => l.contactListId === listId && actor.roleId && l.roleId === actor.roleId);
}

// ¿Puede EDITARLA y dar de alta/baja miembros? Exige `canManage` en el enlace, además
// del permiso `contacts:manage` que comprueba el guard: son cosas distintas —el permiso
// dice "puede gestionar carteras", el enlace dice "puede gestionar ESTA".
export function canManageList(actor: Actor, listId: string, links: ListRoleLink[]): boolean {
  if (isAdmin(actor)) return true;
  return links.some(
    (l) => l.contactListId === listId && l.canManage && actor.roleId && l.roleId === actor.roleId,
  );
}
