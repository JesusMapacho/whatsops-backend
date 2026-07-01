import { Body, Controller, Get, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';
import { CurrentUser, AuthUser } from './current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() body: any) {
    return this.auth.register(body);
  }

  @Public()
  @Post('login')
  login(@Body() body: any) {
    return this.auth.login(body);
  }

  // Usuario actual + permisos resueltos (para gating de UI y topbar).
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }
}
