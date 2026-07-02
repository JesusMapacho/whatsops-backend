import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { VerificationService } from '../verification/verification.service';

const E164 = /^\+[1-9]\d{7,14}$/;

// Cada usuario solo toca su propio perfil. Los códigos van por VerificationService
// (hasheados, con expiración y rate-limit); nunca se loguean ni se devuelven.
@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: VerificationService,
  ) {}

  async get(userId: string) {
    const u = await this.mustFind(userId);
    return this.toPublic(u);
  }

  // Edición de datos básicos del propio perfil. Cambiar el email lo marca como
  // no verificado (habría que re-verificarlo).
  async update(userId: string, body: any) {
    const u = await this.mustFind(userId);
    const data: any = {};
    if (typeof body?.email === 'string' && body.email.trim()) {
      const email = body.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new BadRequestException('Email inválido');
      }
      if (email !== u.email) {
        data.email = email;
        data.emailVerified = false;
      }
    }
    if (!Object.keys(data).length) return this.toPublic(u);
    try {
      const updated = await this.prisma.user.update({ where: { id: userId }, data });
      return this.toPublic(updated);
    } catch (e: any) {
      if (e?.code === 'P2002') throw new BadRequestException('El email ya existe en este tenant');
      throw e;
    }
  }

  // --- Cambio de contraseña: código al correo + contraseña actual ---

  async requestPasswordCode(userId: string) {
    const u = await this.mustFind(userId);
    return this.codes.requestCode(userId, 'password_reset', 'email', u.email);
  }

  async confirmPassword(userId: string, body: any) {
    const u = await this.mustFind(userId);
    const current = body?.currentPassword;
    const next = body?.newPassword;
    if (typeof next !== 'string' || next.length < 8) {
      throw new BadRequestException('La nueva contraseña debe tener al menos 8 caracteres');
    }
    if (typeof current !== 'string' || !(await bcrypt.compare(current, u.passwordHash))) {
      throw new UnauthorizedException('Contraseña actual incorrecta');
    }
    await this.codes.verifyCode(userId, 'password_reset', body?.code);
    const passwordHash = await bcrypt.hash(next, 10);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    return { changed: true };
  }

  // --- Correo (verificación) ---

  async requestEmailCode(userId: string) {
    const u = await this.mustFind(userId);
    return this.codes.requestCode(userId, 'email_verify', 'email', u.email);
  }

  async verifyEmail(userId: string, body: any) {
    await this.mustFind(userId);
    await this.codes.verifyCode(userId, 'email_verify', body?.code);
    await this.prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
    return { emailVerified: true };
  }

  // --- Teléfono ---

  async setPhone(userId: string, body: any) {
    await this.mustFind(userId);
    const phone = String(body?.phone ?? '').trim();
    if (!E164.test(phone)) throw new BadRequestException('Teléfono inválido (formato E.164, ej. +5215555555555)');
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { phone, phoneVerified: false },
    });
    return this.toPublic(updated);
  }

  async requestPhoneCode(userId: string, body: any) {
    const u = await this.mustFind(userId);
    if (!u.phone) throw new BadRequestException('Registra un teléfono primero');
    const channel = body?.channel === 'whatsapp' ? 'whatsapp' : 'sms';
    return this.codes.requestCode(userId, 'phone_verify', channel, u.phone);
  }

  async verifyPhone(userId: string, body: any) {
    await this.mustFind(userId);
    await this.codes.verifyCode(userId, 'phone_verify', body?.code);
    await this.prisma.user.update({ where: { id: userId }, data: { phoneVerified: true } });
    return { phoneVerified: true };
  }

  private async mustFind(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u) throw new NotFoundException('Usuario no encontrado');
    return u;
  }

  private toPublic(u: {
    id: string;
    email: string;
    role: string;
    phone: string | null;
    phoneVerified: boolean;
    emailVerified: boolean;
  }) {
    return {
      id: u.id,
      email: u.email,
      role: u.role,
      phone: u.phone,
      phoneVerified: u.phoneVerified,
      emailVerified: u.emailVerified,
    };
  }
}
