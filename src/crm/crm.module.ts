import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { EventsModule } from '../events/events.module';
import { CrmContactsService } from './contacts.service';
import { ActivitiesService } from './activities.service';
import { DealsService } from './deals.service';
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
@Module({
  imports: [PrismaModule, StorageModule, EventsModule],
  controllers: [
    CrmContactsController,
    TagsController,
    ActivitiesController,
    DealTimelineController,
    DealsController,
    PipelinesController,
    StagesController,
  ],
  providers: [CrmContactsService, ActivitiesService, DealsService],
  exports: [ActivitiesService, DealsService],
})
export class CrmModule {}
