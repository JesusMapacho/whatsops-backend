import { Controller, Get, Param, Query } from '@nestjs/common';
import { ErrorLogsService } from './error-logs.service';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

// Auditoría de la API por tenant. logs:read. El admin ve SUS logs; la vista
// cross-tenant del super-admin llega con la consola de plataforma (feature 03).
@RequirePermissions('logs:read')
@Controller('error-logs')
export class ErrorLogsController {
  constructor(private readonly logs: ErrorLogsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('statusCode') statusCode?: string,
    @Query('path') path?: string,
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('text') text?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    return this.logs.list(
      user.tenantId,
      {
        statusCode: statusCode ? Number(statusCode) : undefined,
        path: path || undefined,
        userId: userId || undefined,
        from: parseDate(from),
        to: parseDate(to),
        text: text || undefined,
      },
      limit ? Number(limit) : undefined,
      before,
    );
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.logs.get(user.tenantId, id);
  }
}

function parseDate(v?: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}
