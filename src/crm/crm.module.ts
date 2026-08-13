import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { CrmContactsService } from './contacts.service';
import { ActivitiesService } from './activities.service';
import {
  ActivitiesController,
  CrmContactsController,
  DealTimelineController,
  TagsController,
} from './crm.controller';

// CRM (v8): ficha del cliente, etiquetas y timeline. El embudo y las tareas (features 36 y
// 37) entran aquí mismo cuando se construyan.
//
// `StorageModule` porque el avatar del contacto se sirve con URL firmada, igual que en la
// bandeja: la key sola no le sirve al navegador y las URLs caducan.
@Module({
  imports: [PrismaModule, StorageModule],
  controllers: [
    CrmContactsController,
    TagsController,
    ActivitiesController,
    DealTimelineController,
  ],
  providers: [CrmContactsService, ActivitiesService],
  exports: [ActivitiesService],
})
export class CrmModule {}
