import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { caducaEn, correosDe, esCorreo, MAX_POR_ENVIO, vigente } from './correos';

// Tope de invitaciones vivas por tenant. Ninguna necesidad medida pide más, y sin
// tope esto es un generador de enlaces gratis para cualquiera con users:manage.
const MAX_PENDIENTES = 50;
const MAX_NOTA = 280;
// Reenviar no tiene freno de tiempo a propósito: no manda ningún correo (solo rota el
// token y devuelve el enlace), así que no hay nada que abusar. Un freno aquí solo
// conseguía que el admin que no copió el enlace recién creado se quedara un minuto sin
// poder recuperarlo — el enlace no se guarda en claro, reenviar ES la única salida.
// El volumen ya lo limita MAX_PENDIENTES.

// Dónde vive el frontend, para armar el enlace. Sin variable, el de desarrollo.
const APP_URL_POR_DEFECTO = 'http://localhost:4200';

type InvitacionVigencia = { expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null };

/**
 * Invitaciones por enlace de un solo uso.
 *
 * No hay correo saliente en este producto (`CodeSender` sigue siendo un stub), así
 * que el enlace se le devuelve al admin UNA vez y él lo reparte por donde ya habla
 * con esa persona. Es menos automático y es honesto: no hay ningún punto en el que
 * el sistema afirme haber enviado algo que no envió.
 *
 * Del token solo se guarda el sha256. Se devuelve en claro en la respuesta de crear
 * y de reenviar, y en ningún otro sitio: ni en la lista, ni en logs.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {}

  // ── Lado admin ──────────────────────────────────────────────────────────────

  async create(tenantId: string, invitedById: string, body: any) {
    const emails = correosDe(body?.emails ?? body?.email);
    if (!emails.length) throw new BadRequestException('Escribe al menos un correo');
    if (emails.length > MAX_POR_ENVIO) {
      throw new BadRequestException(`Como mucho ${MAX_POR_ENVIO} correos por envío`);
    }
    const malos = emails.filter((e) => !esCorreo(e));
    if (malos.length) {
      throw new BadRequestException(`Correo mal escrito: ${malos.join(', ')}`);
    }

    const role = await this.mustRole(tenantId, body?.roleId);
    const note = this.nota(body?.note);

    // Quien ya tiene cuenta no se invita: se le cambia el rol desde el equipo.
    const yaSon = await this.prisma.user.findMany({
      where: { tenantId, email: { in: emails } },
      select: { email: true },
    });
    if (yaSon.length) {
      throw new ConflictException(
        `Ya hay una cuenta con ${yaSon.map((u) => u.email).join(', ')}`,
      );
    }

    const vivas = await this.prisma.invitation.count({
      where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (vivas + emails.length > MAX_PENDIENTES) {
      throw new BadRequestException(
        `Hay demasiadas invitaciones sin aceptar (tope ${MAX_PENDIENTES}). Anula alguna antes.`,
      );
    }

    const salida: { id: string; email: string; link: string }[] = [];
    for (const email of emails) {
      const { token, tokenHash } = this.nuevoToken();
      const datos = {
        roleId: role.id,
        tokenHash,
        note,
        invitedById,
        expiresAt: caducaEn(new Date()),
        acceptedAt: null,
        revokedAt: null,
      };
      // Si ya había una invitación viva para ese correo se rota, no se duplica:
      // dos enlaces vivos para la misma persona solo sirven para confundir.
      const previa = await this.prisma.invitation.findFirst({
        where: { tenantId, email, acceptedAt: null, revokedAt: null },
        select: { id: true },
      });
      const inv = previa
        ? await this.prisma.invitation.update({ where: { id: previa.id }, data: datos })
        : await this.prisma.invitation.create({ data: { tenantId, email, ...datos } });
      salida.push({ id: inv.id, email, link: this.link(token) });
    }
    return salida;
  }

  // Solo las que siguen en el aire: aceptadas y anuladas no son una bandeja de
  // historial, y esta pantalla no es la de auditoría.
  async list(tenantId: string) {
    const invs = await this.prisma.invitation.findMany({
      where: { tenantId, acceptedAt: null, revokedAt: null },
      orderBy: { updatedAt: 'desc' },
      include: { role: { select: { id: true, name: true } } },
    });
    const quienes = await this.quienInvita(invs.map((i) => i.invitedById));
    return invs.map((i) => ({
      id: i.id,
      email: i.email,
      roleId: i.roleId,
      roleName: i.role?.name ?? null,
      note: i.note,
      invitedBy: i.invitedById ? (quienes.get(i.invitedById) ?? null) : null,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      expiresAt: i.expiresAt,
    }));
  }

  async resend(tenantId: string, id: string) {
    const inv = await this.mustFind(tenantId, id);
    if (inv.acceptedAt) throw new ConflictException('Esa invitación ya se aceptó');
    if (inv.revokedAt) throw new ConflictException('Esa invitación está anulada');
    const { token, tokenHash } = this.nuevoToken();
    await this.prisma.invitation.update({
      where: { id: inv.id },
      data: { tokenHash, expiresAt: caducaEn(new Date()) },
    });
    return { id: inv.id, email: inv.email, link: this.link(token) };
  }

  async revoke(tenantId: string, id: string) {
    const inv = await this.mustFind(tenantId, id);
    if (inv.acceptedAt) throw new ConflictException('Esa invitación ya se aceptó');
    await this.prisma.invitation.update({
      where: { id: inv.id },
      data: { revokedAt: new Date() },
    });
    return { revoked: true };
  }

  // ── Lado invitado (público, sin sesión) ─────────────────────────────────────

  /**
   * Lo justo para pintar la pantalla de aceptar: quién invita y a qué. No devuelve
   * nada del tenant que no esté ya en el enlace que esa persona tiene en la mano.
   */
  async preview(token: string) {
    const inv = await this.porToken(token);
    return {
      email: inv.email,
      tenantName: inv.tenant.name,
      roleName: inv.role?.name ?? 'agent',
      note: inv.note,
      expiresAt: inv.expiresAt,
    };
  }

  async accept(token: string, body: any) {
    const inv = await this.porToken(token);
    const password = body?.password;
    if (typeof password !== 'string' || password.length < 8) {
      throw new BadRequestException('La contraseña debe tener al menos 8 caracteres');
    }
    const firstName = this.nombre(body?.firstName);
    const lastName = this.nombre(body?.lastName);
    const passwordHash = await bcrypt.hash(password, 10);

    // Si el rol se borró entre invitar y aceptar (roleId queda a null por SetNull),
    // entra como agente: el rol de menos alcance, nunca el de más.
    const roleId = inv.roleId ?? (await this.systemRoleId(inv.tenantId, 'agent'));
    const esAdmin = inv.role?.isSystem === true && inv.role.name === 'admin';

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const creado = await tx.user.create({
          data: {
            tenantId: inv.tenantId,
            email: inv.email,
            passwordHash,
            firstName,
            lastName,
            // Espejo del enum, igual que en users.service: solo el rol de sistema
            // admin da el bypass de PermissionsGuard.
            role: (esAdmin ? 'admin' : 'agent') as UserRole,
            roleId,
          },
        });
        await tx.invitation.update({
          where: { id: inv.id },
          data: { acceptedAt: new Date() },
        });
        return creado;
      });
      // Misma forma de respuesta que POST /auth/login: el frontend guarda la sesión
      // con el código que ya tiene, y cuando v6 mueva el JWT a cookie esto se mueve
      // con él sin tocar aquí.
      return this.auth.sign(
        user.id,
        user.tenantId,
        user.role,
        user.roleId,
        inv.tenant.onboardingComplete,
      );
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new ConflictException('Ya hay una cuenta con ese correo');
      }
      throw e;
    }
  }

  // ── Interno ─────────────────────────────────────────────────────────────────

  private nuevoToken() {
    // 32 bytes: no hay fuerza bruta que valga, así que el hash puede ser rápido y
    // determinista (que es lo que hace falta para poder buscar por él).
    const token = randomBytes(32).toString('base64url');
    return { token, tokenHash: this.hash(token) };
  }

  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private link(token: string) {
    const base = (this.config.get<string>('APP_URL') || APP_URL_POR_DEFECTO).replace(/\/+$/, '');
    return `${base}/aceptar?t=${token}`;
  }

  // Busca por el hash y decide en un sitio por qué no sirve. El mensaje distingue
  // los tres casos: quien recibe un enlace muerto merece saber si insistir o pedir
  // otro.
  private async porToken(token: string) {
    if (typeof token !== 'string' || token.length < 20) {
      throw new NotFoundException('Ese enlace de invitación no existe');
    }
    const inv = await this.prisma.invitation.findUnique({
      where: { tokenHash: this.hash(token) },
      include: {
        tenant: { select: { name: true, status: true, onboardingComplete: true } },
        role: { select: { id: true, name: true, isSystem: true } },
      },
    });
    if (!inv) throw new NotFoundException('Ese enlace de invitación no existe');
    if (!vigente(inv as InvitacionVigencia, new Date())) {
      throw new GoneException(this.porQueNoSirve(inv));
    }
    if (inv.tenant.status === 'suspended') {
      throw new GoneException('La cuenta de este negocio está suspendida');
    }
    return inv;
  }

  private porQueNoSirve(inv: InvitacionVigencia): string {
    if (inv.acceptedAt) return 'Esta invitación ya se usó. Entra con tu correo y contraseña.';
    if (inv.revokedAt) return 'Esta invitación fue anulada. Pide una nueva a quien te invitó.';
    return 'Esta invitación caducó. Pide una nueva a quien te invitó.';
  }

  private async mustFind(tenantId: string, id: string) {
    const inv = await this.prisma.invitation.findFirst({ where: { id, tenantId } });
    if (!inv) throw new NotFoundException('Invitación no encontrada');
    return inv;
  }

  private async mustRole(tenantId: string, roleId: unknown) {
    if (typeof roleId !== 'string' || !roleId) {
      throw new BadRequestException('Elige un rol para la invitación');
    }
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, tenantId },
      select: { id: true, name: true, isSystem: true },
    });
    if (!role) throw new BadRequestException('roleId inválido para este tenant');
    return role;
  }

  private async systemRoleId(tenantId: string, name: UserRole) {
    const role = await this.prisma.role.findUnique({
      where: { tenantId_name: { tenantId, name } },
      select: { id: true },
    });
    return role?.id ?? null;
  }

  // Nombre de quien invitó, para la línea «Invitada hace 2 h por Ana Ruiz».
  private async quienInvita(ids: (string | null)[]) {
    const unicos = [...new Set(ids.filter((i): i is string => !!i))];
    if (!unicos.length) return new Map<string, string>();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unicos } },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    return new Map(
      users.map((u) => [
        u.id,
        [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
      ]),
    );
  }

  private nota(v: unknown) {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_NOTA) : null;
  }

  private nombre(v: unknown) {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null;
  }
}
