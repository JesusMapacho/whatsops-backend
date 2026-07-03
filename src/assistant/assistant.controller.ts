import { Body, Controller, Post } from '@nestjs/common';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { SupervisorService, AssistantReply } from './supervisor';

interface ChatBody {
  messages: Array<{ role: string; content: string }>;
}

interface ConfirmBody {
  tool: string;
  conversationId: string;
  args?: { status?: string; note?: string };
}

@Controller('assistant')
export class AssistantController {
  constructor(private readonly supervisor: SupervisorService) {}

  // Autenticado por el JwtAuthGuard global; tenantId/role salen del JWT (@CurrentUser).
  @Post('chat')
  chat(@CurrentUser() user: AuthUser, @Body() body: ChatBody): Promise<AssistantReply> {
    return this.supervisor.run(user, body?.messages ?? []);
  }

  // Ejecuta una mutación destructiva que el usuario confirmó (botón del widget).
  @Post('confirm')
  confirm(@CurrentUser() user: AuthUser, @Body() body: ConfirmBody): Promise<AssistantReply> {
    return this.supervisor.confirm(user, body);
  }
}
