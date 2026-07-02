import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { verifyBillingSignature } from './billing.signature';

export const BILLING_QUEUE = 'billing-events';

@Injectable()
export class BillingService {
  private readonly logger = new Logger('Billing');
  private readonly enabled: boolean;
  private readonly webhookSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(BILLING_QUEUE) private readonly queue: Queue,
    config: ConfigService,
  ) {
    // ponytail: proveedor tras flag. Con STRIPE_ENABLED=false (def) el flujo es
    // stub verificable; con true se cablearía el SDK de Stripe (SetupIntent +
    // constructEvent). El PAN nunca toca el backend en ninguno de los dos modos.
    this.enabled = config.get('STRIPE_ENABLED') === 'true';
    this.webhookSecret = config.get<string>('STRIPE_WEBHOOK_SECRET') ?? 'dev-billing-secret';
  }

  // Estado del método de pago de Meta para los costos de conversación. Reusa la
  // conexión WABA (token cifrado de v1-02). Solo estado/enlace, sin PAN.
  // ponytail: enlace a Business Manager; la llamada real a Graph API se añade
  // cuando haya credenciales productivas.
  async metaPaymentStatus(tenantId: string) {
    const conn = await this.prisma.wabaConnection.findFirst({
      where: { tenantId },
      select: { id: true, wabaId: true, businessId: true },
    });
    return {
      connected: !!conn,
      wabaId: conn?.wabaId ?? null,
      manageUrl: 'https://business.facebook.com/billing_hub/accounts',
      note: 'La gestión del método de pago de la WABA se hace en Meta Business Manager.',
    };
  }

  // Alta de método de pago: en modo real crearía un SetupIntent de Stripe y
  // devolvería su client_secret para que el navegador tokenice (PAN → Stripe).
  // En stub devuelve un client_secret simulado; el backend nunca ve el PAN.
  async createSetupIntent(tenantId: string) {
    if (tenantId === 'platform') {
      throw new BadRequestException('La plataforma no tiene suscripción propia.');
    }
    const sub = await this.ensureSubscription(tenantId);
    if (this.enabled) {
      // Aquí iría: stripe.setupIntents.create({ customer }) → client_secret real.
      this.logger.warn('STRIPE_ENABLED=true pero el SDK no está cableado en esta build acotada.');
    }
    return {
      enabled: this.enabled,
      clientSecret: this.enabled ? null : `seti_stub_${tenantId}_secret`,
      customerId: sub.tenantId,
    };
  }

  // Confirma un método tokenizado del lado cliente. Recibe SOLO identificadores
  // no sensibles del proveedor (nunca el PAN).
  async attachPaymentMethod(
    tenantId: string,
    body: { providerCustomerId?: string; providerPaymentMethodId?: string; brand?: string; last4?: string },
  ) {
    const pm = await this.prisma.paymentMethod.create({
      data: {
        tenantId,
        providerCustomerId: body.providerCustomerId ?? null,
        providerPaymentMethodId: body.providerPaymentMethodId ?? `pm_stub_${Date.now()}`,
        brand: body.brand ?? 'visa',
        last4: (body.last4 ?? '4242').slice(-4),
        status: 'active',
      },
    });
    return this.toPublicPm(pm);
  }

  async status(tenantId: string) {
    // La plataforma (super-admin) NO paga suscripción de sí misma: solo gestión de Meta.
    if (tenantId === 'platform') {
      return {
        enabled: this.enabled,
        meta: await this.metaPaymentStatus(tenantId),
        subscription: null,
        paymentMethods: [],
      };
    }
    const [methods, sub, meta] = await Promise.all([
      this.prisma.paymentMethod.findMany({
        where: { tenantId, status: { not: 'removed' } },
        orderBy: { createdAt: 'desc' },
      }),
      this.ensureSubscription(tenantId),
      this.metaPaymentStatus(tenantId),
    ]);
    return {
      enabled: this.enabled,
      meta,
      subscription: this.toPublicSub(sub),
      paymentMethods: methods.map((m) => this.toPublicPm(m)),
    };
  }

  // Webhook del proveedor: verifica firma → persiste (pending) → encola → 200.
  // Nunca procesa inline (principio de CLAUDE.md).
  async ingestWebhook(rawBody: Buffer, signature?: string) {
    if (!verifyBillingSignature(rawBody, signature, this.webhookSecret)) {
      throw new UnauthorizedException('Firma de webhook inválida');
    }
    let event: any;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new UnauthorizedException('Payload inválido');
    }
    await this.queue.add('process', { event });
    return { received: true };
  }

  // Aplica un evento del proveedor a la suscripción (lo llama el worker).
  async applyEvent(event: any) {
    const tenantId: string | undefined = event?.tenantId ?? event?.data?.tenantId;
    if (!tenantId) return;
    const statusMap: Record<string, string> = {
      'invoice.paid': 'active',
      'customer.subscription.updated': event?.data?.status ?? 'active',
      'customer.subscription.deleted': 'canceled',
      'invoice.payment_failed': 'past_due',
    };
    const status = statusMap[event?.type] ?? event?.data?.status;
    if (!status) return;
    await this.prisma.subscription.updateMany({ where: { tenantId }, data: { status } });
  }

  private async ensureSubscription(tenantId: string) {
    return this.prisma.subscription.upsert({
      where: { tenantId },
      create: { tenantId },
      update: {},
    });
  }

  private toPublicPm(m: any) {
    // Nunca exponer secretos del proveedor más allá de lo no sensible.
    return { id: m.id, brand: m.brand, last4: m.last4, status: m.status, createdAt: m.createdAt };
  }

  private toPublicSub(s: any) {
    return {
      plan: s.plan,
      status: s.status,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
    };
  }
}
