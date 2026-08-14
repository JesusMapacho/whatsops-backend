import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { RequirePermissions } from '../auth/permissions.decorator';
import { TasksService } from './tasks.service';

// Tareas y agenda (v8 feature 37): la otra mitad del embudo. El tablero dice DÓNDE está el
// dinero; esto dice QUÉ hacer hoy para moverlo.
//
// Leer con `deals:read`, escribir con `tasks:write`. El alcance por filas lo pone `taskScope`
// en el servicio: el permiso dice qué acciones, el scope qué filas.
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  // Antes de `:id` a propósito: si fuera después, Nest resolvería `/tasks/resumen` como
  // `:id = 'resumen'`.
  @Get('resumen')
  @RequirePermissions('deals:read')
  resumen(@CurrentUser() user: AuthUser) {
    return this.tasks.resumen(user.tenantId, user.userId, user.role);
  }

  @Get()
  @RequirePermissions('deals:read')
  list(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.tasks.list(user.tenantId, query, user.userId, user.role, user.roleId ?? null);
  }

  @Post()
  @RequirePermissions('tasks:write')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.tasks.create(user.tenantId, body, user.userId, user.role);
  }

  @Patch(':id')
  @RequirePermissions('tasks:write')
  patch(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.tasks.patch(user.tenantId, id, body, user.userId, user.role);
  }

  @Post(':id/complete')
  @RequirePermissions('tasks:write')
  complete(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.tasks.complete(user.tenantId, id, body, user.userId, user.role);
  }

  @Delete(':id')
  @RequirePermissions('tasks:write')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasks.remove(user.tenantId, id, user.userId, user.role);
  }
}
