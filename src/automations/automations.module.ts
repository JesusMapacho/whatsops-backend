import { Module, OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../events/events.module';
import { MessagingModule } from '../messaging/messaging.module';
import { CrmModule } from '../crm/crm.module';
import { AutomationsController } from './automations.controller';
import { AutomationsHooksController } from './automations-hooks.controller';
import { AutomationsHooksService } from './automations-hooks.service';
import { AutomationsService } from './automations.service';
import { AutomationsProcessor } from './automations.processor';

// Orquestador de automatizaciones (v3 features 17-18).
//
// Importa MessagingModule y CrmModule porque los nodos ENVUELVEN sus servicios: la ventana
// de 24 h, los topes anti-baneo y las reglas del embudo valen igual desde una automatización
// que desde la pantalla, porque es el mismo código.
//
// Las colas (creación + reintentos) las registra AutomationsProcessor.onModuleInit, no este
// módulo: es el mismo provider que hace `work()`, así que no depende del orden de
// inicialización entre providers para que la cola exista antes de usarse.
@Module({
  imports: [PrismaModule, EventsModule, MessagingModule, CrmModule],
  controllers: [AutomationsController, AutomationsHooksController],
  providers: [AutomationsService, AutomationsHooksService, AutomationsProcessor],
  exports: [AutomationsService],
})
export class AutomationsModule implements OnModuleInit {
  constructor(private readonly automations: AutomationsService) {}

  // Los schedules de pg-boss viven en Postgres, no en una cache: ya sobreviven un reinicio
  // por sí solos. Esto es solo higiene al arrancar, para una automatización que cambió de
  // trigger (o se activó/desactivó) mientras el proceso estaba caído.
  async onModuleInit() {
    await this.automations.reponerCrons();
    await this.automations.programarBarrido();
  }
}
