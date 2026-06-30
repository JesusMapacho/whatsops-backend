import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: true conserva req.rawBody (Buffer) para verificar el HMAC del webhook.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors();
  const port = app.get(ConfigService).get<number>('PORT') ?? 3000;
  await app.listen(port);
  console.log(`WhatsOps backend escuchando en http://localhost:${port}`);
}
bootstrap();
