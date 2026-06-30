import { Body, Controller, Param, Post } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly messaging: MessagingService) {}

  @Post(':id/messages')
  send(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.messaging.send(user.tenantId, id, body);
  }
}
