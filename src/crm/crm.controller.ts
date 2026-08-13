import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CrmContactsService } from './contacts.service';
import { ActivitiesService } from './activities.service';

// Ficha del cliente (v8 feature 35): datos, etiquetas y timeline.
//
// El `tenantId` y el rol salen SIEMPRE del token (`@CurrentUser`), nunca del body — es el
// invariante que sostiene el multi-tenant.
@Controller('contacts')
export class CrmContactsController {
  constructor(
    private readonly contacts: CrmContactsService,
    private readonly activities: ActivitiesService,
  ) {}

  @Get()
  @RequirePermissions('deals:read')
  list(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.contacts.list(user.tenantId, query, user.userId, user.role);
  }

  @Get(':id')
  @RequirePermissions('deals:read')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.contacts.get(user.tenantId, id, user.userId, user.role);
  }

  @Patch(':id')
  @RequirePermissions('deals:write')
  patch(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.contacts.patch(user.tenantId, id, body);
  }

  // PUT y no PATCH: se manda el juego COMPLETO de etiquetas. Un POST/DELETE por etiqueta
  // convierte "quité dos y puse una" en tres peticiones que pueden quedar a medias.
  @Put(':id/tags')
  @RequirePermissions('deals:write')
  setTags(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.contacts.setTags(user.tenantId, id, body);
  }

  @Get(':id/timeline')
  @RequirePermissions('deals:read')
  timeline(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.activities.contactTimeline(user.tenantId, id, query);
  }
}

// Catálogo de etiquetas del negocio. Leer es de agente; MANTENER el catálogo es de admin,
// con el mismo corte que `contacts:read` / `contacts:manage`: quien renombra una etiqueta
// se la renombra a todo el equipo.
@Controller('tags')
export class TagsController {
  constructor(private readonly contacts: CrmContactsService) {}

  @Get()
  @RequirePermissions('deals:read')
  list(@CurrentUser() user: AuthUser) {
    return this.contacts.listTags(user.tenantId);
  }

  @Post()
  @RequirePermissions('deals:manage')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.contacts.createTag(user.tenantId, body);
  }

  @Patch(':id')
  @RequirePermissions('deals:manage')
  patch(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.contacts.patchTag(user.tenantId, id, body);
  }

  @Delete(':id')
  @RequirePermissions('deals:manage')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.contacts.removeTag(user.tenantId, id);
  }
}

// Registro manual de actividad, y el timeline de un trato.
@Controller('activities')
export class ActivitiesController {
  constructor(private readonly activities: ActivitiesService) {}

  @Post()
  @RequirePermissions('deals:write')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.activities.createManual(user.tenantId, user.userId, user.role, body);
  }
}

// Timeline de un trato. Vive aquí y no con el resto de `/deals` porque es la misma consulta
// que el timeline del contacto; la feature 36 añade su propio `@Controller('deals')` con el
// CRUD, y Nest fusiona las rutas de los dos sin problema.
@Controller('deals')
export class DealTimelineController {
  constructor(private readonly activities: ActivitiesService) {}

  @Get(':id/timeline')
  @RequirePermissions('deals:read')
  timeline(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.activities.dealTimeline(user.tenantId, id, user.userId, user.role, query);
  }
}
