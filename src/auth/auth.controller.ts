import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { Public } from './public.decorator';
import { CurrentUser, AuthUser } from './current-user.decorator';
import { CookieSink, clearSession, openSession } from './session-cookie';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
  ) {}

  @Public()
  @Post('register')
  async register(@Body() body: any, @Res({ passthrough: true }) res: CookieSink) {
    return openSession(res, await this.auth.register(body));
  }

  /**
   * Login. Devuelve **una de dos cosas**: la sesión (cookie puesta), o un desafío de
   * segundo factor sin cookie ninguna. Una cuenta de plataforma siempre cae en el segundo
   * caso — la contraseña correcta ya no abre nada por sí sola.
   */
  @Public()
  @Post('login')
  async login(@Body() body: any, @Res({ passthrough: true }) res: CookieSink) {
    const r = await this.auth.login(body);
    if ('etapa' in r) return r; // desafío: sin cookie
    return openSession(res, r);
  }

  // --- Segundo factor -----------------------------------------------------------------
  // Públicas porque todavía no hay sesión: el token del desafío es lo único que
  // identifica al usuario, y solo lo tiene quien acertó la contraseña hace <5 min.

  /** Paso 1 del enrolamiento: secreto y URI para meter en la app autenticadora. */
  @Public()
  @Post('mfa/enroll')
  enroll(@Body() body: any) {
    return this.mfa.enroll(String(body?.desafio ?? ''));
  }

  /** Paso 2: el primer código correcto sella el enrolamiento y abre sesión. */
  @Public()
  @Post('mfa/confirm')
  async confirm(@Body() body: any, @Res({ passthrough: true }) res: CookieSink) {
    const { codigosRespaldo, ...sesion } = await this.mfa.confirm(
      String(body?.desafio ?? ''),
      String(body?.codigo ?? ''),
    );
    // Los códigos de respaldo salen en claro UNA vez, como el `tempPassword` de
    // `users.service.ts`. No hay segunda oportunidad de verlos.
    return { ...openSession(res, sesion), codigosRespaldo };
  }

  /** Login de una cuenta ya enrolada. Acepta código de la app o de respaldo. */
  @Public()
  @Post('mfa/verify')
  async verify(@Body() body: any, @Res({ passthrough: true }) res: CookieSink) {
    const { usoCodigoRespaldo, respaldoRestante, ...sesion } = await this.mfa.verify(
      String(body?.desafio ?? ''),
      String(body?.codigo ?? ''),
    );
    return { ...openSession(res, sesion), usoCodigoRespaldo, respaldoRestante };
  }

  // Cerrar sesión ya no es vaciar el almacenamiento del navegador: la cookie es
  // HttpOnly, así que solo el servidor puede borrarla. Público porque cerrar una
  // sesión que ya caducó tiene que funcionar igual (si no, el front se queda con
  // una cookie muerta que no puede tirar).
  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: CookieSink) {
    clearSession(res);
  }

  // Usuario actual + permisos resueltos (para gating de UI y topbar).
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }
}
