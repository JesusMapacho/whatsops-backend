import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermissions('users:manage')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.users.create(user.tenantId, body);
  }

  // Cualquier usuario autenticado ve los usuarios de su propio tenant.
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.users.list(user.tenantId);
  }

  @RequirePermissions('users:manage')
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.users.update(user.tenantId, id, body);
  }

  @RequirePermissions('users:manage')
  @Post(':id/reset-password')
  resetPassword(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.users.resetPassword(user.tenantId, id);
  }

  @RequirePermissions('users:manage')
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.users.remove(user.tenantId, id);
  }
}
