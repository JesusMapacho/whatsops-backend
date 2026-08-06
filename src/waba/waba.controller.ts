import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { WabaService } from './waba.service';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

// Conexiones = solo admin (permiso waba:create). Un agente no las crea NI las ve.
@RequirePermissions('waba:create')
@Controller('waba-connections')
export class WabaController {
  constructor(private readonly waba: WabaService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.waba.create(user.tenantId, body);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.waba.list(user.tenantId);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.waba.remove(user.tenantId, id);
  }

  // QR de emparejamiento de una conexión WAHA, proxeado: la api key de la
  // instancia se queda en el servidor.
  @Get(':id/qr')
  qr(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.waba.qr(user.tenantId, id);
  }

  @Post(':id/restart')
  restart(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.waba.restart(user.tenantId, id);
  }
}
