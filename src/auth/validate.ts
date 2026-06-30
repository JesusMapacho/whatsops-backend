import { BadRequestException } from '@nestjs/common';

// ponytail: validación a mano como en env.validation.ts. Pasar a class-validator
// si los DTOs se multiplican.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCredentials(email: unknown, password: unknown): {
  email: string;
  password: string;
} {
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    throw new BadRequestException('Email inválido');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new BadRequestException('La contraseña debe tener al menos 8 caracteres');
  }
  return { email: email.toLowerCase(), password };
}
