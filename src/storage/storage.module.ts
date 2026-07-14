import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { LocalDiskStorage } from './local-disk.storage';
import { MediaController } from './media.controller';

// Enchufe de storage: hoy disco local. Para S3, implementar otra StorageService y
// cambiar `useClass` aquí; ningún consumidor cambia.
@Module({
  controllers: [MediaController],
  providers: [{ provide: StorageService, useClass: LocalDiskStorage }],
  exports: [StorageService],
})
export class StorageModule {}
