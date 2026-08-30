import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { corsOriginCheck, corsOrigins } from './config/cors';

// La app Angular compilada. `npm run sync:frontend` (local) o el build de Heroku la deja
// aquí antes de arrancar; en `dist/main.js` (build de Nest) __dirname es `dist/`, así que
// esto apunta a `<repo>/public`, hermano de `dist/`, no dentro.
const PUBLIC_DIR = join(__dirname, '..', 'public');
const INDEX_HTML = join(PUBLIC_DIR, 'index.html');

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
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // Toda la API cuelga de /api. Sin esto, la ruta comodín que sirve el `index.html` del
  // SPA (más abajo) no tendría forma de distinguir "no es un archivo estático, pinta la
  // app" de "es un endpoint de la API que no existe, da 404 de verdad" — y con ~20 grupos
  // de rutas en la raíz (auth, health, webhook, crm...) no hay un prefijo natural que las
  // separe si no es este.
  app.setGlobalPrefix('api');

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

  // Sirve el Angular compilado desde el mismo proceso (front y API en un solo dyno de
  // Heroku). `index: false`: el archivo real solo lo sirve el fallback de abajo, para que
  // pase también por él una petición a `/` sin extensión.
  const tieneFrontend = existsSync(INDEX_HTML);
  if (tieneFrontend) {
    app.useStaticAssets(PUBLIC_DIR, { index: false });
  } else {
    console.warn(
      `  Aviso: no hay build del frontend en ${PUBLIC_DIR} — solo responde la API. ` +
        'Corre `npm run sync:frontend` (o copia ahí `dist/whatsops/browser`) antes de desplegar.',
    );
  }

  // Fallback del SPA: `useStaticAssets` de arriba ya intentó servir un archivo real y, si
  // lo encontró, terminó la respuesta ahí — esto solo se ejecuta para lo que NO era un
  // archivo (ej. /clientes/42 recargado a pelo). El guard de /api es lo que evita que una
  // ruta de API inexistente devuelva HTML en vez de un 404 de verdad.
  if (tieneFrontend) {
    app.use((req: any, res: any, next: () => void) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.sendFile(INDEX_HTML);
    });
  }

  const port = app.get(ConfigService).get<number>('PORT') ?? 3000;
  await app.listen(port);
  console.log(`WhatsOps backend escuchando en http://localhost:${port}`);
  console.log(`  CORS: ${corsOrigins().join(', ')}`);
  // Donde el que despliega ya está mirando: si esta base no es la pública de verdad, las URL
  // de los hooks que copien los operadores apuntarán a un sitio al que nadie llega.
  console.log(`  URL de los hooks: ${process.env.API_PUBLIC_URL ?? `http://localhost:${port}`}/api/hooks/<token>`);
  console.log(
    process.env.COOKIE_SECURE === 'false'
      ? '  Cookie de sesión: Secure APAGADO (desarrollo sobre http)'
      : '  Cookie de sesión: Secure encendido (pon COOKIE_SECURE=false para http://localhost)',
  );
}
bootstrap();
