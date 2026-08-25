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

  // Los numeros de la lista: sparkline, estados y ultima ejecucion por flujo.
  //
  // ANTES de `automations/:id`, o esa ruta se traga `metrics` y el servicio busca una
  // automatizacion con ese id.
  //
  // Endpoint aparte y no un campo mas en `GET /automations`: la lista tiene que pintarse
  // aunque esto falle. El argumento entero, en `contrato/45`.
  @Get('automations/metrics')
  @RequirePermissions('automations:manage')
  metricas(@CurrentUser() user: AuthUser, @Query('dias') dias?: string) {
    return this.automations.metricas(user.tenantId, dias);
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

  // Probar sin mandarle nada a nadie (feature 42). Su gemelo de arriba, `/run`, crea un run
  // de VERDAD: el mensaje sale y el trato se crea. Este no toca nada y funciona en borrador.
  @Post('automations/:id/simular')
  @RequirePermissions('automations:manage')
  simular(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.automations.simularFlujo(user.tenantId, id, body);
  }

  // Llamar a la API del nodo UNA vez y devolver la forma de lo que contesta (feature 47).
  // Configurarlo era a ciegas: se tecleaba `{{vars.api.json...}}` adivinando y se descubria si
  // acertaste cuando escribia un cliente.
  //
  // Llama de VERDAD a una URL que teclea alguien, asi que pasa por `assertSafeOutboundUrl` y no
  // sigue redirecciones. No crea ninguna fila.
  @Post('automations/:id/sondear')
  @RequirePermissions('automations:manage')
  sondear(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.automations.sondear(user.tenantId, id, body);
  }

  @Get('automations/:id/runs')
  @RequirePermissions('automations:manage')
  runs(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('limit') limit?: string) {
    return this.automations.runs(user.tenantId, id, Number(limit) || 20);
  }

  // Las de TODO el negocio, con la automatización de cada una: la pregunta «¿qué disparó este
  // mensaje?», que con las ejecuciones solo por automatización no se podía contestar.
  @Get('automation-runs')
  @RequirePermissions('automations:manage')
  todosLosRuns(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    return this.automations.todosLosRuns(user.tenantId, Number(limit) || 30);
  }

  // Desbloquear a mano lo que el barrido tardaría en recoger. Mismo permiso: cancelar un run
  // es menos invasivo que desactivar la automatización, que ya va con este.
  @Post('automation-runs/:id/cancel')
  @RequirePermissions('automations:manage')
  cancelarRun(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.automations.cancelarRun(user.tenantId, id);
  }

  @Delete('automations/:id')
  @RequirePermissions('automations:manage')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.automations.remove(user.tenantId, id);
  }
}
