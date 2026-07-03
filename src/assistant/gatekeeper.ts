import { BadRequestException } from '@nestjs/common';

export const MAX_MESSAGE_CHARS = 2000;

// Portero: saneo + límites de la entrada del usuario. El JWT ya lo validó el
// JwtAuthGuard global (no se revalida aquí); tenantId/role se inyectan aparte.
export function sanitizeInput(text: unknown): string {
  if (typeof text !== 'string') throw new BadRequestException('Mensaje inválido');
  // Quita caracteres de control C0 (salvo tab/newline) y recorta.
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  if (!clean) throw new BadRequestException('Mensaje vacío');
  if (clean.length > MAX_MESSAGE_CHARS) {
    throw new BadRequestException(`Mensaje demasiado largo (máx ${MAX_MESSAGE_CHARS})`);
  }
  return clean;
}

// Marca frases típicas de prompt-injection para registro/telemetría. NO es la defensa
// principal (esa es: tenantId de confianza + SQL solo-SELECT + RLS); es señal, no barrera.
const INJECTION_PATTERNS = [
  /ignore (all |the )?(previous|above) (instructions|prompts)/i,
  /disregard (your|the) (rules|instructions|system)/i,
  /reveal (your |the )?(system )?prompt/i,
  /(act|behave) as (if|though) you (are|were)/i,
  /\bsystem prompt\b/i,
];

export function detectInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}
