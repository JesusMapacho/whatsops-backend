import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { verifySignature } from './signature';
import { webhookType } from './decode';

export const WEBHOOK_QUEUE = 'webhook-events';

@Injectable()
export class WebhookService {
  private readonly appSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue,
    config: ConfigService,
  ) {
    this.appSecret = config.get<string>('META_APP_SECRET') ?? '';
  }

  // Verifica firma → persiste WebhookEvent (pending) → encola por id → 200.
  // Nunca procesa inline. Si la firma falla, lanza 401 y no encola nada.
  async ingest(rawBody: Buffer, signatureHeader?: string) {
    if (!verifySignature(rawBody, signatureHeader, this.appSecret)) {
      throw new UnauthorizedException('Firma inválida');
    }
    const payload = JSON.parse(rawBody.toString('utf8'));
    const event = await this.prisma.webhookEvent.create({
      data: {
        type: webhookType(payload),
        rawPayload: payload,
        signatureValid: true,
        processStatus: 'pending',
      },
    });
    await this.queue.add('process', { webhookEventId: event.id });
    return { received: true };
  }
}
