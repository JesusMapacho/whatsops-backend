import { BullModule } from '@nestjs/bullmq';
import { Module, OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../events/events.module';
import { MessagingModule } from '../messaging/messaging.module';
import { CrmModule } from '../crm/crm.module';
import { AutomationsController } from './automations.controller';
import { AutomationsService } from './automations.service';
import { AutomationsProcessor } from './automations.processor';
import { AUTOMATION_QUEUE } from './automations.queue';

// Orquestador de automatizaciones (v3 features 17-18).
//
// Importa MessagingModule y CrmModule porque los nodos ENVUELVEN sus servicios: la ventana
// de 24 h, los topes anti-baneo y las reglas del embudo valen igual desde una automatización
// que desde la pantalla, porque es el mismo código.
@Module({
  imports: [
    PrismaModule,
    EventsModule,
    MessagingModule,
    CrmModule,
    BullModule.registerQueue({
      name: AUTOMATION_QUEUE,
      // Mismos reintentos que el webhook: un proveedor que no contesta merece otra
      // oportunidad, y la idempotencia por paso evita repetir lo que ya salió.
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 1000,
      },
    }),
  ],
  controllers: [AutomationsController],
  providers: [AutomationsService, AutomationsProcessor],
  exports: [AutomationsService],
})
export class AutomationsModule implements OnModuleInit {
  constructor(private readonly automations: AutomationsService) {}

  // Los jobs repetibles viven en Redis, que es cache y puede vaciarse. Sin esto, un `docker
  // compose down` deja las automatizaciones por hora activas en la base y muertas de hecho.
  async onModuleInit() {
    await this.automations.reponerCrons();
  }
}
