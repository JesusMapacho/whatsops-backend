import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { RequirePermissions } from '../auth/permissions.decorator';
import { DealsService } from './deals.service';

// Embudo: tratos, y su tablero (v8 feature 36).
//
// Leer y operar es de agente (`deals:read` / `deals:write`); configurar el proceso y
// borrar histórico es de admin (`deals:manage`). El alcance por filas lo pone `dealScope`
// en el servicio, no el guard: el permiso dice QUÉ ACCIONES, el scope QUÉ FILAS.
@Controller('deals')
export class DealsController {
  constructor(private readonly deals: DealsService) {}

  @Get()
  @RequirePermissions('deals:read')
  list(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.deals.list(user.tenantId, query, user.userId, user.role);
  }

  // Totales por etapa, aparte del listado: el tope de la lista recortaría la suma y el
  // dueño del negocio vería menos dinero del que tiene.
  @Get('totales')
  @RequirePermissions('deals:read')
  totales(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.deals.totales(user.tenantId, query, user.userId, user.role);
  }

  @Post()
  @RequirePermissions('deals:write')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.deals.create(user.tenantId, body, user.userId, user.role);
  }

  @Patch(':id')
  @RequirePermissions('deals:write')
  patch(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.deals.patch(user.tenantId, id, body, user.userId, user.role);
  }

  @Patch(':id/status')
  @RequirePermissions('deals:write')
  setStatus(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.deals.setStatus(user.tenantId, id, body, user.userId, user.role);
  }

  @Delete(':id')
  @RequirePermissions('deals:manage')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.deals.remove(user.tenantId, id);
  }
}

@Controller('pipelines')
export class PipelinesController {
  constructor(private readonly deals: DealsService) {}

  @Get()
  @RequirePermissions('deals:read')
  list(@CurrentUser() user: AuthUser) {
    return this.deals.pipelines(user.tenantId);
  }

  @Post()
  @RequirePermissions('deals:manage')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.deals.createPipeline(user.tenantId, body);
  }

  // PUT porque se manda el juego COMPLETO de etapas con su orden. Reordenar reescribe
  // todas las posiciones, así que partirlo en varias peticiones dejaría el tablero a
  // medias si una falla.
  @Put(':id/stages')
  @RequirePermissions('deals:manage')
  setStages(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.deals.setStages(user.tenantId, id, body);
  }

  @Delete(':id')
  @RequirePermissions('deals:manage')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.deals.removePipeline(user.tenantId, id);
  }
}

@Controller('stages')
export class StagesController {
  constructor(private readonly deals: DealsService) {}

  // Borrar exige decir a dónde van los tratos: la FK es NO ACTION justo para que la base
  // no permita dejarlos apuntando al vacío.
  @Delete(':id')
  @RequirePermissions('deals:manage')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('moveToStageId') moveToStageId?: string,
  ) {
    return this.deals.removeStage(user.tenantId, id, moveToStageId);
  }
}
