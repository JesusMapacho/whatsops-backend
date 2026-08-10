import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
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

  // Renombrar. Lo único editable: el resto define QUÉ conexión es.
  @Patch(':id')
  rename(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.waba.rename(user.tenantId, id, body);
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

  // Alternativa al QR: código de 8 dígitos que se teclea en el teléfono.
  // El código va en la respuesta y no se persiste.
  @Post(':id/request-code')
  requestCode(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.waba.requestCode(user.tenantId, id, body?.phone);
  }
}
