import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Req,
} from '@nestjs/common';
import { BillingService } from './billing.service';
import { Public } from '../auth/public.decorator';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @RequirePermissions('billing:manage')
  @Get('status')
  status(@CurrentUser() user: AuthUser) {
    return this.billing.status(user.tenantId);
  }

  @RequirePermissions('billing:manage')
  @Post('setup-intent')
  setupIntent(@CurrentUser() user: AuthUser) {
    return this.billing.createSetupIntent(user.tenantId);
  }

  // El navegador tokeniza el PAN con el proveedor y envía SOLO identificadores.
  @RequirePermissions('billing:manage')
  @Post('payment-method')
  attach(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.billing.attachPaymentMethod(user.tenantId, body ?? {});
  }

  // Webhook del proveedor: público, verifica firma, encola. Cuerpo crudo
  // (main.ts arranca con rawBody: true).
  @Public()
  @Post('webhook')
  webhook(
    @Req() req: { rawBody?: Buffer },
    @Headers('stripe-signature') stripeSig?: string,
    @Headers('x-billing-signature') stubSig?: string,
  ) {
    return this.billing.ingestWebhook(req.rawBody ?? Buffer.alloc(0), stripeSig ?? stubSig);
  }
}
