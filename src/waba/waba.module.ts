import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../crypto/crypto.module';
import { WabaService } from './waba.service';
import { WabaController } from './waba.controller';

@Module({
  imports: [PrismaModule, CryptoModule],
  controllers: [WabaController],
  providers: [WabaService],
})
export class WabaModule {}
