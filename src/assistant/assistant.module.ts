import { Module } from '@nestjs/common';
import { SupervisorService } from './supervisor';
import { BranchBService } from './rag/branch-b.service';
import { AssistantController } from './assistant.controller';

@Module({
  controllers: [AssistantController],
  providers: [SupervisorService, BranchBService],
  exports: [SupervisorService],
})
export class AssistantModule {}
