import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { BroadcastService } from './broadcast.service';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { RequirePermissions } from '../auth/permissions.decorator';

// Envíos masivos. TODO el controlador exige `conversations:outbound`: los agentes
// contestan, prospectar es de admin.
@Controller('broadcasts')
@RequirePermissions('conversations:outbound')
export class BroadcastController {
  constructor(private readonly broadcasts: BroadcastService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.broadcasts.list(user.tenantId);
  }

  // Recuento SIN crear nada, para que el operador vea lo que va a pasar antes de
  // confirmarlo. Sirve para el CSV y para una cartera.
  @Post('preview')
  preview(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.broadcasts.preview(
      user.tenantId,
      { role: user.role, roleId: user.roleId ?? null },
      body,
    );
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    // El actor viaja porque los destinatarios pueden salir de una cartera, y el acceso a
    // una cartera se decide por ROL, no solo por permiso.
    return this.broadcasts.create(
      user.tenantId,
      user.userId,
      { role: user.role, roleId: user.roleId ?? null },
      body,
    );
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.broadcasts.detail(user.tenantId, id);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.broadcasts.cancel(user.tenantId, id);
  }
}
