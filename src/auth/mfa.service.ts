import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { AuthService } from './auth.service';
import { estaBloqueado, requiereSegundoFactor, trasIntento } from './mfa';
import {
  generarCodigoRespaldo,
  generarSecreto,
  normalizarCodigoRespaldo,
  uriOtpauth,
  verificarTotp,
} from './totp';

/** Cuántos códigos de respaldo se entregan al enrolar. */
const CODIGOS_RESPALDO = 8;

/** Por debajo de esto la UI avisa de que quedan pocos. */
export const RESPALDO_BAJO = 2;

/**
 * Enrolamiento y verificación del segundo factor.
 *
 * Ninguna de estas operaciones tiene sesión abierta todavía: se autentican con el token
 * intermedio que emitió `login`. De ahí que las rutas sean `@Public()` y que el desafío
 * sea lo único que identifica al usuario.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Paso 1 del enrolamiento: entrega un secreto nuevo y su URI.
   *
   * Se puede llamar varias veces; cada llamada **reemplaza** el secreto no confirmado. Eso
   * es a propósito: quien cerró la pestaña a medias tiene que poder volver a empezar, y un
   * secreto sin `totpConfirmedAt` no vale como segundo factor (ver `mfa.ts`).
   *
   * Se niega a rotar un secreto YA confirmado: para eso está el reseteo de §4, que deja
   * rastro. Si no, cualquiera con un desafío vivo podría cambiar el factor de la cuenta.
   */
  async enroll(desafio: string): Promise<{ secreto: string; uri: string; email: string }> {
    const userId = await this.auth.leerDesafio(desafio, 'enroll');
    const user = await this.mustUser(userId);
    if (user.totpConfirmedAt) {
      throw new BadRequestException('Esta cuenta ya tiene segundo factor.');
    }

    const secreto = generarSecreto();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        totpSecretEnc: this.crypto.encrypt(secreto),
        totpConfirmedAt: null,
        totpLastCounter: null,
        totpFailures: 0,
        totpLockedUntil: null,
      },
    });

    // El secreto en claro sale UNA vez, aquí, para que se pueda meter en la app. Nunca se
    // loguea: `redact.ts` tapa por substring `secret`, y el nombre del campo lo cubre.
    return { secreto, uri: uriOtpauth(secreto, user.email), email: user.email };
  }

  /**
   * Paso 2: el primer código correcto sella el enrolamiento, entrega los códigos de
   * respaldo y **ahí** se abre sesión.
   *
   * Los códigos de respaldo se devuelven en claro una sola vez, como el `tempPassword` de
   * `users.service.ts`. Guardarlos recuperables sería tener una segunda copia de la llave.
   */
  async confirm(desafio: string, codigo: string) {
    const userId = await this.auth.leerDesafio(desafio, 'enroll');
    const user = await this.mustUser(userId);
    if (user.totpConfirmedAt) {
      throw new BadRequestException('Esta cuenta ya tiene segundo factor.');
    }
    if (!user.totpSecretEnc) {
      throw new BadRequestException('Primero pide el secreto para enrolar.');
    }

    const ahora = Date.now();
    this.assertNoBloqueado(user, ahora);
    const contador = verificarTotp(this.crypto.decrypt(user.totpSecretEnc), codigo, ahora);
    if (contador === null) {
      await this.anotarIntento(user, false, ahora);
      throw new BadRequestException('El código no coincide. Revisa la hora del teléfono.');
    }

    const codigos = Array.from({ length: CODIGOS_RESPALDO }, generarCodigoRespaldo);
    const hashes = await Promise.all(
      codigos.map((c) => bcrypt.hash(normalizarCodigoRespaldo(c), 10)),
    );
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        totpConfirmedAt: new Date(ahora),
        totpLastCounter: contador,
        totpFailures: 0,
        totpLockedUntil: null,
        recoveryCodeHashes: hashes,
      },
    });

    return { ...(await this.sesionDe(userId)), codigosRespaldo: codigos };
  }

  /**
   * Login de una cuenta ya enrolada: acepta un código de la app o uno de respaldo.
   *
   * `usoCodigoRespaldo` vuelve al frontend para poder decir «te quedan N» y, sobre todo,
   * para llevar a re-enrolar: quien entra con un código de respaldo suele haber perdido el
   * teléfono, que es el caso que estos códigos existen para resolver.
   */
  async verify(desafio: string, codigo: string) {
    const userId = await this.auth.leerDesafio(desafio, 'mfa');
    const user = await this.mustUser(userId);
    if (!user.totpConfirmedAt || !user.totpSecretEnc) {
      throw new BadRequestException('Esta cuenta todavía no tiene segundo factor.');
    }

    const ahora = Date.now();
    this.assertNoBloqueado(user, ahora);

    // Primero el TOTP, que es el camino normal.
    const contador = verificarTotp(this.crypto.decrypt(user.totpSecretEnc), codigo, ahora, {
      minContador: user.totpLastCounter ?? undefined,
    });
    if (contador !== null) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { totpLastCounter: contador, ...trasIntento(user, true, ahora) },
      });
      return { ...(await this.sesionDe(userId)), usoCodigoRespaldo: false, respaldoRestante: user.recoveryCodeHashes.length };
    }

    // Luego los de respaldo. Se comparan contra todos porque van con hash: no se puede
    // buscar por valor, hay que probar. Son ocho, así que el coste es acotado.
    const indice = await this.buscarRespaldo(user.recoveryCodeHashes, codigo);
    if (indice >= 0) {
      const restantes = user.recoveryCodeHashes.filter((_, i) => i !== indice);
      await this.prisma.user.update({
        where: { id: userId },
        data: { recoveryCodeHashes: restantes, ...trasIntento(user, true, ahora) },
      });
      return { ...(await this.sesionDe(userId)), usoCodigoRespaldo: true, respaldoRestante: restantes.length };
    }

    await this.anotarIntento(user, false, ahora);
    // Mismo mensaje que el fallo de TOTP y que el bloqueo, igual que hace `verifyCode` en
    // `verification.service.ts`: no se filtra si el código existía ni en qué estado está la
    // cuenta.
    throw new BadRequestException('El código no coincide. Revisa la hora del teléfono.');
  }

  /**
   * Reseteo por otro admin de plataforma (§4). Deja la cuenta obligada a enrolar de nuevo.
   *
   * No borra los códigos de respaldo aquí: los reemplaza el `confirm` del nuevo
   * enrolamiento. Borrarlos ahora dejaría a la cuenta sin ninguna vía si el reseteo fue un
   * error.
   */
  async reset(userId: string) {
    const user = await this.mustUser(userId);
    if (!requiereSegundoFactor(user)) {
      throw new BadRequestException('Esa cuenta no usa segundo factor.');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        totpSecretEnc: null,
        totpConfirmedAt: null,
        totpLastCounter: null,
        totpFailures: 0,
        totpLockedUntil: null,
      },
    });
    return { reset: true };
  }

  // --- interno -----------------------------------------------------------------------

  private async mustUser(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.status === 'disabled') {
      throw new UnauthorizedException('Credenciales inválidas');
    }
    return user;
  }

  private assertNoBloqueado(user: { totpLockedUntil: Date | null }, ahoraMs: number) {
    if (estaBloqueado(user, ahoraMs)) {
      throw new HttpException(
        'Demasiados intentos. Espera unos minutos.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async anotarIntento(
    user: { id: string; totpFailures: number },
    acerto: boolean,
    ahoraMs: number,
  ) {
    await this.prisma.user.update({
      where: { id: user.id },
      data: trasIntento(user, acerto, ahoraMs),
    });
  }

  private async buscarRespaldo(hashes: string[], codigo: string): Promise<number> {
    const limpio = normalizarCodigoRespaldo(codigo);
    if (!limpio) return -1;
    for (let i = 0; i < hashes.length; i++) {
      if (await bcrypt.compare(limpio, hashes[i])) return i;
    }
    return -1;
  }

  /** Arma la sesión con la misma forma que `login`, reusando `AuthService.sign`. */
  private async sesionDe(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { tenant: { select: { onboardingComplete: true } } },
    });
    return this.auth.sign(
      user.id,
      user.tenantId,
      user.role,
      user.roleId,
      user.tenant?.onboardingComplete ?? true,
    );
  }
}
