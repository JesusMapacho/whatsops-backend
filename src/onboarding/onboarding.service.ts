import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const TOTAL_STEPS = 5;
// El bloqueo por verificación de correo queda LISTO pero desactivable mientras la
// entrega de códigos no esté cableada (ver spec admin-v2/03).
const ENFORCED = process.env.VERIFICATION_ENFORCED === 'true';

// Estado del alta por pasos, en Tenant. Cada quien avanza su propio tenant.
@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  async state(userId: string, tenantId: string) {
    const [tenant, user] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId } }),
      this.prisma.user.findUnique({ where: { id: userId } }),
    ]);
    if (!tenant || !user) throw new NotFoundException('No encontrado');
    return {
      step: tenant.onboardingStep,
      complete: tenant.onboardingComplete,
      totalSteps: TOTAL_STEPS,
      verificationEnforced: ENFORCED,
      tenant: {
        name: tenant.name,
        country: tenant.country,
        timezone: tenant.timezone,
        currency: tenant.currency,
        locale: tenant.locale,
      },
      user: {
        email: user.email,
        emailVerified: user.emailVerified,
        phone: user.phone,
        phoneVerified: user.phoneVerified,
      },
    };
  }

  // Persiste el avance del wizard. Acepta {step} (progreso reanudable) y/o
  // {company} (datos de empresa internacionales).
  async update(userId: string, tenantId: string, body: any) {
    const data: any = {};

    if (body?.company) {
      Object.assign(data, this.validateCompany(body.company));
    }

    if (body?.step !== undefined) {
      const step = Number(body.step);
      if (!Number.isInteger(step) || step < 1 || step > TOTAL_STEPS) {
        throw new BadRequestException('step fuera de rango');
      }
      // Solo avanza (no retrocede el progreso guardado).
      const t = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { onboardingStep: true },
      });
      data.onboardingStep = Math.max(step, t?.onboardingStep ?? 1);
    }

    if (Object.keys(data).length) {
      await this.prisma.tenant.update({ where: { id: tenantId }, data });
    }
    return this.state(userId, tenantId);
  }

  // Finaliza el alta. Con bloqueo activo exige correo verificado.
  async complete(userId: string, tenantId: string) {
    if (ENFORCED) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { emailVerified: true },
      });
      if (!user?.emailVerified) {
        throw new BadRequestException('Verifica tu correo para completar el registro');
      }
    }
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { onboardingComplete: true, onboardingStep: TOTAL_STEPS },
    });
    return this.state(userId, tenantId);
  }

  private validateCompany(c: any) {
    const out: any = {};
    if (typeof c.name === 'string' && c.name.trim()) out.name = c.name.trim();

    const country = String(c.country ?? '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw new BadRequestException('País inválido (ISO-3166 alpha-2)');
    out.country = country;

    const currency = String(c.currency ?? '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new BadRequestException('Moneda inválida (ISO-4217)');
    out.currency = currency;

    const timezone = String(c.timezone ?? '');
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
      if (!timezone) throw new Error('vacío');
    } catch {
      throw new BadRequestException('Zona horaria inválida (IANA)');
    }
    out.timezone = timezone;

    const locale = String(c.locale ?? '');
    try {
      if (!Intl.getCanonicalLocales(locale).length) throw new Error('vacío');
    } catch {
      throw new BadRequestException('Locale inválido');
    }
    out.locale = locale;

    return out;
  }
}
