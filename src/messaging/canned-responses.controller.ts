import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { CannedResponsesService } from './canned-responses.service';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller('canned-responses')
export class CannedResponsesController {
  constructor(private readonly canned: CannedResponsesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.canned.list(user.tenantId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.canned.create(user.tenantId, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.canned.remove(user.tenantId, id);
  }
}
