import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module';
import { ErrorLogsService } from './error-logs.service';
import { ErrorLogsController } from './error-logs.controller';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { RequestIdInterceptor } from './request-id.interceptor';

// APP_FILTER y APP_INTERCEPTOR se aplican globalmente aunque se declaren aquí.
@Module({
  imports: [PrismaModule],
  controllers: [ErrorLogsController],
  providers: [
    ErrorLogsService,
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [ErrorLogsService],
})
export class ObservabilityModule {}
