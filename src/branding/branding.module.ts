import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { BrandingController } from './branding.controller';
import { BrandingService } from './branding.service';

@Module({
  imports: [PrismaModule, StorageModule],
  controllers: [BrandingController],
  providers: [BrandingService],
})
export class BrandingModule {}
