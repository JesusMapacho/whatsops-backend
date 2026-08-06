import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../auth/public.decorator';
import { ping } from '../waha/waha.client';

@Controller('health')
export class HealthController {
  private readonly wahaUrl: string;
  private readonly wahaKey: string;

  constructor(config: ConfigService) {
    this.wahaUrl = (config.get<string>('WAHA_URL') ?? '').replace(/\/$/, '');
    this.wahaKey = config.get<string>('WAHA_API_KEY') ?? '';
  }

  // El código HTTP NO depende de WAHA a propósito: devolver 503 porque la capa
  // gratuita está caída tumbaría la app entera en cualquier balanceador. La alerta
  // correcta va sobre el gauge waha_sessions, no sobre /health.
  @Public()
  @Get()
  async check() {
    return { status: 'ok', waha: await this.wahaStatus() };
  }

  private async wahaStatus(): Promise<'up' | 'down' | 'disabled'> {
    if (!this.wahaUrl || !this.wahaKey) return 'disabled';
    try {
      await ping(this.wahaUrl, this.wahaKey);
      return 'up';
    } catch {
      return 'down';
    }
  }
}
