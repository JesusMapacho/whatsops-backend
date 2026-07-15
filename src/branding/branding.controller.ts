import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { BrandingService, UploadedLogo } from './branding.service';
import { Roles } from '../auth/roles.decorator';
import { Public } from '../auth/public.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller('branding')
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.branding.get(user.tenantId);
  }

  @Roles('admin')
  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.branding.update(user.tenantId, body);
  }

  @Roles('admin')
  @Post('logo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  uploadLogo(@CurrentUser() user: AuthUser, @UploadedFile() file: UploadedLogo) {
    return this.branding.uploadLogo(user.tenantId, file);
  }

  // Branding público por tenantId: lo consume el widget embebido ANTES de auth.
  // Solo devuelve name/accentColor/logoUrl; nunca datos sensibles ni de otros tenants.
  @Public()
  @Get('public/:tenantId')
  getPublic(@Param('tenantId') tenantId: string) {
    return this.branding.getPublic(tenantId);
  }
}
