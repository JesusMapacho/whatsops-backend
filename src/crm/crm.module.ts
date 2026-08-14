import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { EventsModule } from '../events/events.module';
import { RolesModule } from '../roles/roles.module';
import { CrmContactsService } from './contacts.service';
import { ActivitiesService } from './activities.service';
import { DealsService } from './deals.service';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { KpisService } from './kpis.service';
import { KpisController } from './kpis.controller';
import {
  ActivitiesController,
  CrmContactsController,
  DealTimelineController,
  TagsController,
} from './crm.controller';
import { DealsController, PipelinesController, StagesController } from './deals.controller';

// CRM (v8): ficha del cliente, etiquetas y timeline. El embudo y las tareas (features 36 y
// 37) entran aquí mismo cuando se construyan.
//
// `StorageModule` porque el avatar del contacto se sirve con URL firmada, igual que en la
// bandeja: la key sola no le sirve al navegador y las URLs caducan.
// `RolesModule` por el conmutador «del equipo» de la agenda: resolver `deals:manage` de
// verdad es lo que hace que un rol a medida vea las tareas de todos, en vez de que la UI
// ofrezca un conmutador que el servidor ignora.
@Module({
  imports: [PrismaModule, StorageModule, EventsModule, RolesModule],
  controllers: [
    CrmContactsController,
    TagsController,
    ActivitiesController,
    DealTimelineController,
    DealsController,
    PipelinesController,
    StagesController,
    TasksController,
    KpisController,
  ],
  providers: [CrmContactsService, ActivitiesService, DealsService, TasksService, KpisService],
  exports: [ActivitiesService, DealsService, TasksService],
})
export class CrmModule {}
