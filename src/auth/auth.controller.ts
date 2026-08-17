import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';
import { CurrentUser, AuthUser } from './current-user.decorator';
import { CookieSink, clearSession, openSession } from './session-cookie';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  async register(@Body() body: any, @Res({ passthrough: true }) res: CookieSink) {
    return openSession(res, await this.auth.register(body));
  }

  @Public()
  @Post('login')
  async login(@Body() body: any, @Res({ passthrough: true }) res: CookieSink) {
    return openSession(res, await this.auth.login(body));
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
