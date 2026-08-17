import { Body, Controller, Delete, Get, Param, Post, Res } from '@nestjs/common';
import { InvitationsService } from './invitations.service';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { CookieSink, openSession } from '../auth/session-cookie';

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  // Gestionar invitaciones es dar de alta gente: mismo permiso que crear usuarios.
  @RequirePermissions('users:manage')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.invitations.create(user.tenantId, user.userId, body);
  }

  @RequirePermissions('users:manage')
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.invitations.list(user.tenantId);
  }

  @RequirePermissions('users:manage')
  @Post(':id/resend')
  resend(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.invitations.resend(user.tenantId, id);
  }

  @RequirePermissions('users:manage')
  @Delete(':id')
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.invitations.revoke(user.tenantId, id);
  }

  // Las dos rutas de abajo son públicas por definición: quien las usa todavía no
  // tiene cuenta. El token es la única credencial, y va en la ruta bajo /token/
  // para no chocar con :id de arriba.
  @Public()
  @Get('token/:token')
  preview(@Param('token') token: string) {
    return this.invitations.preview(token);
  }

  // Aceptar deja la sesión abierta, y desde la feature 31 eso significa emitir la cookie
  // aquí también: es la tercera puerta que abre sesión.
  @Public()
  @Post('token/:token/accept')
  async accept(
    @Param('token') token: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: CookieSink,
  ) {
    return openSession(res, await this.invitations.accept(token, body));
  }
}
