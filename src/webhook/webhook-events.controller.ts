import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { WebhookEventsService } from './webhook-events.service';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

// Auditoría: solo admin. El scoping por tenant lo aplica el servicio.
@Roles('admin')
@Controller('webhook-events')
export class WebhookEventsController {
  constructor(private readonly events: WebhookEventsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('type') type?: string,
    @Query('processStatus') processStatus?: string,
    @Query('signatureValid') signatureValid?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    return this.events.list(
      user.tenantId,
      {
        type: type || undefined,
        processStatus: processStatus || undefined,
        signatureValid: parseBool(signatureValid),
        from: parseDate(from),
        to: parseDate(to),
      },
      limit ? Number(limit) : undefined,
      before,
    );
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.events.get(user.tenantId, id);
  }

  @Post(':id/replay')
  replay(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.events.replay(user.tenantId, id);
  }
}

function parseBool(v?: string): boolean | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function parseDate(v?: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}
