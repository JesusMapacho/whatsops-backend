import { Controller, Get, Post } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller('templates')
export class TemplatesController {
  constructor(private readonly messaging: MessagingService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.messaging.listTemplates(user.tenantId);
  }

  @Roles('admin')
  @Post('sync')
  sync(@CurrentUser() user: AuthUser) {
    return this.messaging.syncTemplates(user.tenantId);
  }
}
