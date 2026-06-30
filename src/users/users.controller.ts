import { Body, Controller, Get, Post } from '@nestjs/common';
import { UsersService } from './users.service';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Roles('admin')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.users.create(user.tenantId, body);
  }

  // Cualquier usuario autenticado ve los usuarios de su propio tenant.
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.users.list(user.tenantId);
  }
}
