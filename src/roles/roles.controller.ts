import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { RolesService } from './roles.service';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  // Catálogo de permisos disponibles (código versionado).
  @RequirePermissions('roles:manage')
  @Get('permissions')
  catalog() {
    return this.roles.listCatalog();
  }

  @RequirePermissions('roles:manage')
  @Get('roles')
  list(@CurrentUser() user: AuthUser) {
    return this.roles.list(user.tenantId);
  }

  @RequirePermissions('roles:manage')
  @Post('roles')
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.roles.create(user.tenantId, body);
  }

  @RequirePermissions('roles:manage')
  @Get('roles/:id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.roles.get(user.tenantId, id);
  }

  @RequirePermissions('roles:manage')
  @Patch('roles/:id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.roles.update(user.tenantId, id, body);
  }

  @RequirePermissions('roles:manage')
  @Delete('roles/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.roles.remove(user.tenantId, id);
  }

  @RequirePermissions('roles:manage')
  @Put('roles/:id/permissions')
  setPermissions(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.roles.setPermissions(user.tenantId, id, body);
  }
}
