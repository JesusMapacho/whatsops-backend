import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Public } from '../../auth/public.decorator';
import { PosServiceGuard } from './pos-service.guard';
import { PosIntegrationService } from './pos-integration.service';

// Servicio-a-servicio: `@Public()` para que JwtAuthGuard/CsrfGuard (globales) no
// exijan cookie de sesión, y `PosServiceGuard` en su lugar para exigir el
// secreto compartido con POS_SERVER. No hay `req.user` en ningún handler de
// aquí — quien llama es el backend del POS, no una persona.
@Public()
@UseGuards(PosServiceGuard)
@Controller('integrations/pos')
export class PosIntegrationController {
  constructor(private readonly pos: PosIntegrationService) {}

  @Post('provision')
  provision(@Body() body: any) {
    return this.pos.provision(body);
  }

  @Post('sso-token')
  ssoToken(@Body() body: any) {
    return this.pos.issueSsoToken(body);
  }
}
