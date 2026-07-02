import {
  BadRequestException,
  Inject,
  Injectable,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { CODE_SENDER, CodeChannel, CodeSender } from './code-sender';

export type CodePurpose = 'password_reset' | 'email_verify' | 'phone_verify';

const TTL_MS = 10 * 60 * 1000; // vigencia del código
const MIN_INTERVAL_MS = 60 * 1000; // 1 envío/min por (user,purpose)
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_WINDOW = 5; // tope de solicitudes por ventana
const MAX_ATTEMPTS = 5; // intentos de verificación por código

// Genera/valida códigos de un solo uso. Guarda SOLO el hash; nunca loguea ni
// devuelve el código en claro (salvo eco de dev explícito, apagado por defecto).
@Injectable()
export class VerificationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CODE_SENDER) private readonly sender: CodeSender,
  ) {}

  async requestCode(
    userId: string,
    purpose: CodePurpose,
    channel: CodeChannel,
    dest: string,
  ): Promise<{ sent: true; devCode?: string }> {
    const now = Date.now();
    const recent = await this.prisma.verificationCode.findMany({
      where: { userId, purpose, createdAt: { gt: new Date(now - WINDOW_MS) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (recent[0] && now - recent[0].createdAt.getTime() < MIN_INTERVAL_MS) {
      throw this.tooMany('Espera un momento antes de pedir otro código');
    }
    if (recent.length >= MAX_PER_WINDOW) {
      throw this.tooMany('Demasiadas solicitudes; intenta más tarde');
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = await bcrypt.hash(code, 10);
    await this.prisma.verificationCode.create({
      data: { userId, purpose, channel, codeHash, expiresAt: new Date(now + TTL_MS) },
    });
    await this.sender.send(dest, channel, code);

    // ponytail: eco de dev tras flag OFF por defecto; en prod jamás se emite.
    const echo = process.env.AUTH_DEV_ECHO_CODES === 'true';
    return echo ? { sent: true, devCode: code } : { sent: true };
  }

  // Valida el código vigente más reciente del propósito. Consume al acertar;
  // suma intento y descarta al fallar/expirar/exceder intentos.
  async verifyCode(userId: string, purpose: CodePurpose, code: string): Promise<boolean> {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      throw new BadRequestException('Código inválido');
    }
    const rec = await this.prisma.verificationCode.findFirst({
      where: { userId, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!rec || rec.attempts >= MAX_ATTEMPTS) {
      throw new BadRequestException('Código inválido o expirado');
    }
    const ok = await bcrypt.compare(code, rec.codeHash);
    if (!ok) {
      await this.prisma.verificationCode.update({
        where: { id: rec.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('Código inválido o expirado');
    }
    await this.prisma.verificationCode.update({
      where: { id: rec.id },
      data: { consumedAt: new Date() },
    });
    return true;
  }

  private tooMany(msg: string) {
    return new HttpException(msg, HttpStatus.TOO_MANY_REQUESTS);
  }
}
