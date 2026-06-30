import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { WabaService } from './waba.service';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller('waba-connections')
export class WabaController {
  constructor(private readonly waba: WabaService) {}

  @Roles('admin')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.waba.create(user.tenantId, body);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.waba.list(user.tenantId);
  }

  @Roles('admin')
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.waba.remove(user.tenantId, id);
  }
}
