import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Header,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from './metrics.service';
import { Public } from '../auth/public.decorator';

// /metrics NO es público de cara a internet: se protege con METRICS_TOKEN
// (Bearer o ?token=). En despliegue real, además, restringir por red interna.
// @Public evita el JwtAuthGuard (Prometheus no lleva JWT de usuario).
@Public()
@Controller('metrics')
export class MetricsController {
  private readonly token: string;

  constructor(
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.token = config.get<string>('METRICS_TOKEN') ?? '';
  }

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(
    @Headers('authorization') auth?: string,
    @Query('token') queryToken?: string,
  ): Promise<string> {
    if (this.token) {
      const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
      if (bearer !== this.token && queryToken !== this.token) {
        throw new ForbiddenException('Token de métricas inválido');
      }
    }
    return this.metrics.scrape();
  }
}
