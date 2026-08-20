import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AutomationsService } from './automations.service';

// Orquestador de automatizaciones (v3 features 17-18).
//
// Todo con `automations:manage`, incluido leer: un grafo lleva dentro a qué agente se asigna
// cada cosa y qué se le contesta a quién, y quien puede editarlo le cambia el comportamiento
// del canal a todo el equipo. Mismo corte que `deals:manage`.
@Controller()
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  // La paleta del editor. Es el catálogo en código, igual para todos los tenants.
  @Get('automation-nodes/catalog')
  @RequirePermissions('automations:manage')
  catalogo() {
    return this.automations.catalogo();
  }

  // Las funciones de `{{ruta | funcion:arg}}`, también en código e iguales para todos. Van
  // por la API y NO copiadas a mano en el frontend: así una función nueva aparece en el
  // autocompletado y se pinta como función sin tocar la pantalla.
  @Get('automation-functions')
  @RequirePermissions('automations:manage')
  funciones() {
    return this.automations.funciones();
  }

  // Las constantes del negocio (`{{ajustes.<name>}}`). Un PUT que reemplaza el juego
  // entero, igual que `PUT /automations/:id/graph`: es una pantalla con un botón de
  // guardar, no un CRUD fila a fila.
  @Get('automation-variables')
  @RequirePermissions('automations:manage')
  variables(@CurrentUser() user: AuthUser) {
    return this.automations.variables(user.tenantId);
  }

  @Put('automation-variables')
  @RequirePermissions('automations:manage')
  guardarVariables(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.automations.guardarVariables(user.tenantId, body);
  }

  // Rota la URL pública del disparador de webhook. Rompe la integración que use la vieja,
  // pero NO apaga la automatización: rotar una credencial no cambia lo que hace.
  @Post('automations/:id/hook/regenerate')
  @RequirePermissions('automations:manage')
  regenerarHook(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.automations.regenerarHook(user.tenantId, id);
  }

  @Get('automations')
  @RequirePermissions('automations:manage')
  list(@CurrentUser() user: AuthUser) {
    return this.automations.list(user.tenantId);
  }

  @Post('automations')
  @RequirePermissions('automations:manage')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.automations.create(user.tenantId, body, user.userId);
  }

  @Get('automations/:id')
  @RequirePermissions('automations:manage')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.automations.get(user.tenantId, id);
  }

  // Renombrar / cambiar el disparador. Cambiar el disparador la devuelve a borrador.
  @Patch('automations/:id')
  @RequirePermissions('automations:manage')
  patch(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.automations.patch(user.tenantId, id, body);
  }

  // PUT y no PATCH: manda el grafo entero y reemplaza el que hubiera.
  @Put('automations/:id/graph')
  @RequirePermissions('automations:manage')
  graph(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.automations.guardarGrafo(user.tenantId, id, body);
  }

  @Post('automations/:id/activate')
  @RequirePermissions('automations:manage')
  activate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.automations.setStatus(user.tenantId, id, true, user.userId);
  }

  @Post('automations/:id/deactivate')
  @RequirePermissions('automations:manage')
  deactivate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.automations.setStatus(user.tenantId, id, false, user.userId);
  }

  @Post('automations/:id/run')
  @RequirePermissions('automations:manage')
  run(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.automations.runManual(user.tenantId, id, body);
  }

  @Get('automations/:id/runs')
  @RequirePermissions('automations:manage')
  runs(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('limit') limit?: string) {
    return this.automations.runs(user.tenantId, id, Number(limit) || 20);
  }

  @Delete('automations/:id')
  @RequirePermissions('automations:manage')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.automations.remove(user.tenantId, id);
  }
}
