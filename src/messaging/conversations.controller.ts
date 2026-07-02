import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { ConversationsService } from './conversations.service';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly messaging: MessagingService,
    private readonly conversations: ConversationsService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('filter') filter?: string) {
    return this.conversations.list(user.tenantId, filter, user.userId, user.role);
  }

  @Get(':id/messages')
  history(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    return this.conversations.history(
      user.tenantId,
      id,
      user.userId,
      user.role,
      limit ? Number(limit) : undefined,
      before,
    );
  }

  @Post(':id/messages')
  async send(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    // Un agente solo envía en conversaciones suyas o abiertas.
    await this.conversations.assertAccess(user.tenantId, id, user.userId, user.role);
    return this.messaging.send(user.tenantId, id, body);
  }

  @Post(':id/assign')
  assign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.conversations.assign(user.tenantId, id, body?.userId, user.userId, user.role);
  }

  @Patch(':id/status')
  setStatus(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.conversations.setStatus(user.tenantId, id, body?.status, user.userId, user.role);
  }

  @Get(':id/notes')
  listNotes(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.conversations.listNotes(user.tenantId, id, user.userId, user.role);
  }

  @Post(':id/notes')
  addNote(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.conversations.addNote(user.tenantId, id, user.userId, user.role, body?.body);
  }
}
