import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { ObservabilityModule } from '../observability/observability.module';
import { SupervisorService } from './supervisor';
import { BranchBService } from './rag/branch-b.service';
import { BranchAService } from './mutations/branch-a.service';
import { AssistantController } from './assistant.controller';

@Module({
  imports: [MessagingModule, ObservabilityModule],
  controllers: [AssistantController],
  providers: [SupervisorService, BranchBService, BranchAService],
  exports: [SupervisorService],
})
export class AssistantModule {}
