import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PgBossService } from '../queue/pgboss.service';
import { verifySignature } from './signature';
import { webhookType } from './decode';
import { verifyWahaSignature, wahaHmacKey } from './waha';

export const WEBHOOK_QUEUE = 'webhook-events';

@Injectable()
export class WebhookService {
  private readonly appSecret: string;
  private readonly wahaSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PgBossService,
    config: ConfigService,
  ) {
    this.appSecret = config.get<string>('META_APP_SECRET') ?? '';
    this.wahaSecret = config.get<string>('WAHA_WEBHOOK_SECRET') ?? '';
  }

  // Verifica firma → persiste WebhookEvent (pending) → encola por id → 200.
  // Nunca procesa inline. Si la firma falla, lanza 401 y no encola nada.
  async ingest(rawBody: Buffer, signatureHeader?: string) {
    if (!verifySignature(rawBody, signatureHeader, this.appSecret)) {
      throw new UnauthorizedException('Firma inválida');
    }
    return this.persistAndQueue(JSON.parse(rawBody.toString('utf8')));
  }

  // Igual que ingest() pero con la firma de WAHA: HMAC-SHA512 hex sin prefijo, y
  // con la clave derivada del nombre de sesión. Se puede parsear antes de
  // verificar porque `session` solo se usa como sal del HMAC: sin el maestro
  // nadie produce un digest válido para ningún valor de ella.
  async ingestWaha(rawBody: Buffer, hmacHeader?: string) {
    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new UnauthorizedException('Firma inválida');
    }
    const session = typeof payload?.session === 'string' ? payload.session : '';
    const key = wahaHmacKey(this.wahaSecret, session);
    if (!this.wahaSecret || !verifyWahaSignature(rawBody, hmacHeader, key)) {
      throw new UnauthorizedException('Firma inválida');
    }
    return this.persistAndQueue(payload);
  }

  private async persistAndQueue(payload: any) {
    const event = await this.prisma.webhookEvent.create({
      data: {
        type: webhookType(payload),
        rawPayload: payload,
        signatureValid: true,
        processStatus: 'pending',
      },
    });
    await this.queue.send(WEBHOOK_QUEUE, { webhookEventId: event.id });
    return { received: true };
  }
}
