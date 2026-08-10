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
    // Sin este manejador, un archivo que falta emite un 'error' que no captura nadie
    // y tumba el proceso ENTERO: `stream.pipe()` no lo propaga a la promesa del
    // handler, así que Nest nunca lo ve. Y faltar puede faltar (borrado, storage
    // recreado, carrera con el existsSync): una imagen ausente es un 404, no una caída.
    stream.on('error', () => {
      if (res.headersSent) res.destroy();
      else {
        res.statusCode = 404;
        res.end();
      }
    });
    stream.pipe(res);
  }
}
