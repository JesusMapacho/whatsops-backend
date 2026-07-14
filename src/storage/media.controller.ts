import { Controller, ForbiddenException, Get, Param, Query, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { Public } from '../auth/public.decorator';
import { StorageService } from './storage.service';

// Sirve archivos de media. Público como los presigned de S3: gateado por firma, no por JWT
// (un <img src> del navegador no puede llevar Bearer). La firma acota key + expiración.
@Controller('media')
export class MediaController {
  constructor(private readonly storage: StorageService) {}

  @Public()
  @Get(':key')
  async get(
    @Param('key') key: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: ServerResponse,
  ) {
    if (!this.storage.verify(key, exp, sig)) {
      throw new ForbiddenException('Enlace de media inválido o expirado');
    }
    const { stream, mime, size } = await this.storage.getStream(key);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', size);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    stream.pipe(res);
  }
}
