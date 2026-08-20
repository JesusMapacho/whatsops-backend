import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { corsOriginCheck, corsOrigins } from './config/cors';

// Cabeceras de seguridad de la API (v6 feature 32).
//
// ponytail: sin `helmet`. Son cuatro cabeceras fijas y helmet habría que configurarlo
// para apagarle la mitad de sus defaults (su CSP, que aquí no aplica: esta API no sirve
// el HTML de la app — la CSP de la página va en `frontend/src/index.html`). Entra helmet
// el día que la lista crezca o que `frame-ancestors` tenga que salir por tenant.
const CABECERAS: Record<string, string> = {
  // Nada de adivinar el tipo: un adjunto subido como .png no se ejecuta como script.
  'X-Content-Type-Options': 'nosniff',
  // No filtrar la ruta completa (lleva ids de conversación y de trato) a terceros.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // La API no se pinta en un iframe de nadie. El widget embebible es el frontend, no esto.
  'X-Frame-Options': 'DENY',
};

async function bootstrap() {
  // rawBody: true conserva req.rawBody (Buffer) para verificar el HMAC del webhook.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.use((req: any, res: any, next: () => void) => {
    for (const [k, v] of Object.entries(CABECERAS)) res.setHeader(k, v);
    // HSTS solo donde hay https; sobre http es una cabecera muerta, y en localhost
    // además se pega al dominio entero del navegador durante meses.
    if (process.env.COOKIE_SECURE !== 'false') {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  });

  // Origen explícito y `credentials: true`: la cookie de sesión solo viaja si el navegador
  // sabe a quién se le permite. Con `credentials` no se admite comodín ni queriendo.
  app.enableCors({ origin: corsOriginCheck, credentials: true });

  const port = app.get(ConfigService).get<number>('PORT') ?? 3000;
  await app.listen(port);
  console.log(`WhatsOps backend escuchando en http://localhost:${port}`);
  console.log(`  CORS: ${corsOrigins().join(', ')}`);
  // Donde el que despliega ya está mirando: si esta base no es la pública de verdad, las URL
  // de los hooks que copien los operadores apuntarán a un sitio al que nadie llega.
  console.log(`  URL de los hooks: ${process.env.API_PUBLIC_URL ?? `http://localhost:${port}`}/hooks/<token>`);
  console.log(
    process.env.COOKIE_SECURE === 'false'
      ? '  Cookie de sesión: Secure APAGADO (desarrollo sobre http)'
      : '  Cookie de sesión: Secure encendido (pon COOKIE_SECURE=false para http://localhost)',
  );
}
bootstrap();
