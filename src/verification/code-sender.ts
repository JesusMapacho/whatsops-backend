import { Injectable, Logger } from '@nestjs/common';

export type CodeChannel = 'email' | 'sms' | 'whatsapp';

// Seam de entrega: la implementación real (correo/SMS/WhatsApp) se conecta
// después (feature diferida). El contrato nunca recibe el código para loguearlo:
// recibe destino + canal + código y su ÚNICO deber es entregarlo.
export interface CodeSender {
  send(dest: string, channel: CodeChannel, code: string): Promise<void>;
}

// Stub por defecto: NO entrega nada. Registra únicamente que se "envió" (sin el
// código, sin el destino en claro). En prod se reemplaza por un sender real.
// ponytail: no-op; swap por proveedor real (SES/Twilio/Cloud API) al cablear.
@Injectable()
export class StubCodeSender implements CodeSender {
  private readonly log = new Logger('CodeSender');
  async send(_dest: string, channel: CodeChannel, _code: string): Promise<void> {
    this.log.log(`código de verificación encolado (canal=${channel}) [stub]`);
  }
}

export const CODE_SENDER = Symbol('CODE_SENDER');
