import { Body, Controller, Post } from '@nestjs/common';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { SupervisorService, AssistantReply } from './supervisor';

interface ChatBody {
  messages: Array<{ role: string; content: string }>;
}

@Controller('assistant')
export class AssistantController {
  constructor(private readonly supervisor: SupervisorService) {}

  // Autenticado por el JwtAuthGuard global; tenantId/role salen del JWT (@CurrentUser).
  @Post('chat')
  chat(@CurrentUser() user: AuthUser, @Body() body: ChatBody): Promise<AssistantReply> {
    return this.supervisor.run(user, body?.messages ?? []);
  }
}
