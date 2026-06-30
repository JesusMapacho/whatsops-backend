import { Controller, ForbiddenException, Get, Headers, Post, Query, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../auth/public.decorator';
import { WebhookService } from './webhook.service';

@Public()
@Controller('webhook')
export class WebhookController {
  private readonly verifyToken: string;

  constructor(
    private readonly webhook: WebhookService,
    config: ConfigService,
  ) {
    this.verifyToken = config.get<string>('WEBHOOK_VERIFY_TOKEN') ?? '';
  }

  // Handshake de verificación de Meta. Devuelve el challenge en texto plano.
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    if (mode === 'subscribe' && token === this.verifyToken) return challenge;
    throw new ForbiddenException();
  }

  @Post()
  receive(
    @Req() req: { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature?: string,
  ) {
    return this.webhook.ingest(req.rawBody ?? Buffer.alloc(0), signature);
  }
}
