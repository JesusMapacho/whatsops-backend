import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';

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
}
