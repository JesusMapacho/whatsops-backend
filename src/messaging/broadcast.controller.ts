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

  // Lee el CSV y devuelve el recuento SIN crear nada, para que el operador vea lo
  // que va a pasar antes de confirmarlo.
  @Post('preview')
  preview(@Body() body: any) {
    return this.broadcasts.preview(typeof body?.csv === 'string' ? body.csv : '');
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.broadcasts.create(user.tenantId, user.userId, body);
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
