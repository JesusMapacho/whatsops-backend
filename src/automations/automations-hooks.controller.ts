// La ÚNICA ruta pública del orquestador. Vive en su propio archivo y no en
// `automations.controller.ts`, donde las catorce rutas llevan `@RequirePermissions`: un
// `@Public()` en medio de esa lista es lo que alguien convierte en agujero al añadir la ruta
// quince sin mirar.
//
// **Lo que este archivo NO defiende, a propósito.** Un flood con tokens inválidos cuesta un
// regex y, como mucho, un `findUnique` sobre un índice unique. Un limitador por IP aquí sería
// teatro —`POST /auth/login` tampoco lo tiene— y quien pueda saturar esto puede saturar
// `/webhook` igual. Eso vive en el borde (`limit_req` de nginx o Cloudflare sobre `/hooks/`).
// Y la repetición: quien capture la petición la repite. Defenderlo pide firma HMAC, que es
// justo lo que este diseño evita — la URL ES el secreto, ese es el producto. El día que haga
// falta, es un campo en el `configSchema` del trigger y `webhook/signature.ts`, que ya existe.
import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { AutomationsHooksService } from './automations-hooks.service';

@Controller()
export class AutomationsHooksController {
  constructor(private readonly hooks: AutomationsHooksService) {}

  // `@Public()` en el MÉTODO y no en la clase: a nivel de clase convertiría en pública
  // cualquier ruta que alguien añada aquí después, y este archivo existe justamente para
  // protegerse del futuro. Exime del `JwtAuthGuard` y del `CsrfGuard` a la vez, y da igual:
  // no hay sesión que robar, el token es lo único que autoriza.
  //
  // **Solo POST. Ni GET ni HEAD, y no es purismo REST**: si el operador pega la URL en un
  // chat de WhatsApp o de Slack, el previsualizador de enlaces hace un GET — y el flujo se
  // dispararía solo, mandando mensajes a clientes reales.
  @Public()
  @Post('hooks/:token')
  @HttpCode(200)
  recibir(@Param('token') token: string, @Req() req: { rawBody?: Buffer; body?: unknown }) {
    return this.hooks.recibir(token, req.body, req.rawBody?.length ?? 0);
  }
}
