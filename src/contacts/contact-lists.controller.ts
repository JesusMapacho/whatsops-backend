import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ContactListsService } from './contact-lists.service';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { RequirePermissions } from '../auth/permissions.decorator';
import { Actor } from './access';

// Carteras de clientes.
//
// Dos capas de control, y hacen falta las dos: el PERMISO dice si puedes gestionar
// carteras en general (lo comprueba el guard), y el ROL enlazado en cada cartera dice
// sobre CUÁLES (lo comprueba el servicio). Con solo el permiso, cualquier gestor vería
// las carteras de todos los equipos.
@Controller('contact-lists')
export class ContactListsController {
  constructor(private readonly lists: ContactListsService) {}

  @Get()
  @RequirePermissions('contacts:read')
  list(@CurrentUser() user: AuthUser) {
    return this.lists.list(user.tenantId, actorOf(user));
  }

  @Post()
  @RequirePermissions('contacts:manage')
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.lists.create(user.tenantId, user.userId, body);
  }

  @Delete(':id')
  @RequirePermissions('contacts:manage')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.lists.remove(user.tenantId, actorOf(user), id);
  }

  @Get(':id/members')
  @RequirePermissions('contacts:read')
  members(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.lists.members(user.tenantId, actorOf(user), id);
  }

  @Post(':id/members')
  @RequirePermissions('contacts:manage')
  addMember(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.lists.addMember(user.tenantId, actorOf(user), user.userId, id, body);
  }

  @Delete(':id/members/:contactId')
  @RequirePermissions('contacts:manage')
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('contactId') contactId: string,
  ) {
    return this.lists.removeMember(user.tenantId, actorOf(user), id, contactId);
  }

  // Reemplaza los accesos por rol de la cartera.
  @Put(':id/roles')
  @RequirePermissions('contacts:manage')
  setRoles(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.lists.setRoles(user.tenantId, actorOf(user), id, body);
  }
}

function actorOf(user: AuthUser): Actor {
  return { role: user.role, roleId: user.roleId ?? null };
}
