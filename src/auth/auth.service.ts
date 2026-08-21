import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { RolesService } from '../roles/roles.service';
import { AuthUser } from './current-user.decorator';
import { validateCredentials } from './validate';
import { etapaTrasPassword, requiereSegundoFactor } from './mfa';
import { claveDesafio, DESAFIO_TTL, EtapaDesafio } from './mfa-token';

@Injectable()
export class AuthService {
  /** Maestro del que se derivan las claves de los desafíos. Ver `mfa-token.ts`. */
  private readonly jwtSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly roles: RolesService,
    config: ConfigService,
  ) {
    // `validateEnv` ya exige JWT_SECRET, así que aquí no puede faltar.
    this.jwtSecret = config.get<string>('JWT_SECRET') ?? '';
  }

  // Registro: crea Tenant + primer User admin en una transacción.
  async register(body: any) {
    const { email, password } = validateCredentials(body?.email, body?.password);
    const tenantName =
      typeof body?.tenantName === 'string' && body.tenantName.trim()
        ? body.tenantName.trim()
        : email;
    const firstName = typeof body?.firstName === 'string' && body.firstName.trim() ? body.firstName.trim() : null;
    const lastName = typeof body?.lastName === 'string' && body.lastName.trim() ? body.lastName.trim() : null;
    const passwordHash = await bcrypt.hash(password, 10);

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({ data: { name: tenantName } });
        // Siembra roles de sistema del nuevo tenant y asigna admin al primer user.
        const { adminRoleId } = await this.roles.ensureSystemRoles(tenant.id, tx);
        return tx.user.create({
          data: {
            tenantId: tenant.id,
            email,
            passwordHash,
            firstName,
            lastName,
            role: 'admin',
            roleId: adminRoleId,
          },
        });
      });
      // Tenant recién creado: onboarding pendiente.
      return this.sign(user.id, user.tenantId, user.role, user.roleId, false);
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new ConflictException('El email ya está registrado');
      }
      throw e;
    }
  }

  async login(body: any) {
    const { email, password } = validateCredentials(body?.email, body?.password);
    // Sin tenant en login: el email es único globalmente en la práctica del MVP.
    // ponytail: findFirst por email; si dos tenants comparten email, añadir
    // selector de tenant en login.
    const user = await this.prisma.user.findFirst({
      where: { email },
      include: { tenant: { select: { status: true, onboardingComplete: true } } },
    });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Credenciales inválidas');
    }
    // Un usuario desactivado no puede loguear (conserva su atribución).
    if (user.status === 'disabled') {
      throw new UnauthorizedException('Usuario desactivado');
    }
    // Tenant suspendido: sus usuarios no operan (el super-admin no lo está).
    if (user.tenant?.status === 'suspended') {
      throw new UnauthorizedException('Tenant suspendido');
    }

    // Segundo factor. La contraseña correcta ya NO basta para una cuenta de plataforma:
    // devuelve un desafío y no una sesión. Ver `mfa.ts` para la política y `mfa-token.ts`
    // para por qué el desafío no puede colarse como cookie de sesión.
    const { etapa } = etapaTrasPassword(user);
    if (etapa !== 'sesion') {
      return {
        etapa,
        desafio: await this.firmarDesafio(user.id, etapa),
        // El email vuelve para poder pintar «entra con el código de ops@…» sin que el
        // frontend tenga que recordarlo entre las dos peticiones.
        email: user.email,
      } as const;
    }

    return this.sign(
      user.id,
      user.tenantId,
      user.role,
      user.roleId,
      user.tenant?.onboardingComplete ?? true,
    );
  }

  /** Firma el token intermedio con la clave derivada de su etapa. */
  async firmarDesafio(userId: string, etapa: EtapaDesafio): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, etapa },
      { secret: claveDesafio(this.jwtSecret, etapa), expiresIn: DESAFIO_TTL },
    );
  }

  /** Verifica un desafío y devuelve el id del usuario, o lanza 401. */
  async leerDesafio(token: string, etapa: EtapaDesafio): Promise<string> {
    try {
      const payload = await this.jwt.verifyAsync(token, {
        secret: claveDesafio(this.jwtSecret, etapa),
      });
      // La etapa va en la clave Y en el cuerpo. Comprobar las dos no es redundante de
      // balde: si algún día alguien reusara la clave, esto sigue separando las etapas.
      if (payload?.etapa !== etapa || typeof payload?.sub !== 'string') {
        throw new Error('etapa incorrecta');
      }
      return payload.sub;
    } catch {
      throw new UnauthorizedException('El desafío caducó. Vuelve a iniciar sesión.');
    }
  }

  async me(auth: AuthUser) {
    const user = await this.prisma.user.findUnique({
      where: { id: auth.userId },
      select: {
        id: true,
        email: true,
        role: true,
        roleId: true,
        status: true,
        isPlatform: true,
        tenantId: true,
        firstName: true,
        lastName: true,
        emailVerified: true,
        phoneVerified: true,
        // `timezone` y `currency` los usa el CRM (v8): la agenda corta el día en la zona del
        // negocio, no en la del navegador, y los importes se formatean con su moneda. Van
        // aquí y no en tres peticiones porque los piden tres pantallas distintas.
        tenant: { select: { onboardingComplete: true, timezone: true, currency: true } },
      },
    });
    if (!user) throw new UnauthorizedException('Usuario no encontrado');
    const permissions = await this.roles.permissionKeysFor(user.role, user.roleId);
    const { tenant, ...rest } = user;
    return {
      ...rest,
      onboardingComplete: tenant?.onboardingComplete ?? true,
      tenant: { timezone: tenant?.timezone ?? null, currency: tenant?.currency ?? null },
      permissions,
    };
  }

  // Pública porque también la usa InvitationsService: aceptar una invitación crea
  // la cuenta y deja la sesión abierta, con exactamente la misma forma que login.
  async sign(
    userId: string,
    tenantId: string,
    role: string,
    roleId: string | null,
    onboardingComplete: boolean,
  ) {
    const accessToken = await this.jwt.signAsync({ sub: userId, tenantId, role, roleId });

    // `mfaPendiente` se calcula AQUÍ, leyéndolo de la DB, y no se recibe por parámetro: así
    // ninguna de las tres puertas (login, registro, aceptar invitación) puede pasarlo mal ni
    // olvidarlo. Cuesta una query en un camino que ya hace varias, y a cambio `openSession`
    // no puede emitir una cookie que se salte el segundo factor. Ver `session-cookie.ts`.
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isPlatform: true, totpConfirmedAt: true },
    });
    const mfaPendiente = !!u && requiereSegundoFactor(u) && !u.totpConfirmedAt;

    return {
      accessToken,
      mfaPendiente,
      user: { id: userId, tenantId, role, roleId, onboardingComplete },
    };
  }
}
