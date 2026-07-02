import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

// Todo autenticado y scoped al propio usuario (userId del token). Sin permiso
// especial: cada quien gestiona su cuenta.
@Controller('profile')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.profile.get(user.userId);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.profile.update(user.userId, body);
  }

  @Post('password/request-code')
  requestPasswordCode(@CurrentUser() user: AuthUser) {
    return this.profile.requestPasswordCode(user.userId);
  }

  @Post('password/confirm')
  confirmPassword(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.profile.confirmPassword(user.userId, body);
  }

  @Post('email/request-code')
  requestEmailCode(@CurrentUser() user: AuthUser) {
    return this.profile.requestEmailCode(user.userId);
  }

  @Post('email/verify')
  verifyEmail(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.profile.verifyEmail(user.userId, body);
  }

  @Post('phone')
  setPhone(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.profile.setPhone(user.userId, body);
  }

  @Post('phone/request-code')
  requestPhoneCode(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.profile.requestPhoneCode(user.userId, body);
  }

  @Post('phone/verify')
  verifyPhone(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.profile.verifyPhone(user.userId, body);
  }
}
