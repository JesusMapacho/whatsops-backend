import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

// Alta por pasos del propio tenant. Autenticado: el paso 1 (crear cuenta) usa
// /auth/register; a partir del 2 el usuario ya tiene token.
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  state(@CurrentUser() user: AuthUser) {
    return this.onboarding.state(user.userId, user.tenantId);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.onboarding.update(user.userId, user.tenantId, body);
  }

  @Post('complete')
  complete(@CurrentUser() user: AuthUser) {
    return this.onboarding.complete(user.userId, user.tenantId);
  }
}
