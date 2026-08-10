import {
  Body,
  Controller,
  Get,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { StatusService } from './status.service';
import { UploadedMediaFile } from './messaging.service';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { RequirePermissions } from '../auth/permissions.decorator';

// Estados ("historias") del WhatsApp del negocio.
//
// ponytail: reutiliza `conversations:outbound` en vez de crear un permiso propio.
// Es la misma clase de acción —algo que sale del número del negocio hacia mucha
// gente— y un permiso nuevo obliga a re-sembrar roles para una función pequeña.
@Controller('status')
@RequirePermissions('conversations:outbound')
export class StatusController {
  constructor(private readonly status: StatusService) {}

  // Conexiones que pueden publicar, y si pueden BORRAR (en NOWEB no). La UI lo avisa
  // antes de publicar en vez de ofrecer un botón que no existe.
  @Get('connections')
  connections(@CurrentUser() user: AuthUser) {
    return this.status.connections(user.tenantId);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.status.list(user.tenantId);
  }

  @Post()
  // Un solo endpoint para texto y media: el tipo se deriva del MIME del archivo.
  // FileInterceptor con multipart deja el resto del formulario en `body`.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  publish(
    @CurrentUser() user: AuthUser,
    @Body() body: any,
    @UploadedFile() file?: UploadedMediaFile,
  ) {
    // El actor viaja porque la audiencia puede salir de una cartera, y el acceso a una
    // cartera se decide por ROL.
    return this.status.publish(
      user.tenantId,
      user.userId,
      { role: user.role, roleId: user.roleId ?? null },
      body,
      file,
    );
  }
}
