import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { setupApp } from './app.setup';
import { UPLOADS_DIR, UPLOADS_URL_PREFIX } from './images/images.constants';

async function bootstrap() {
  const app = setupApp(
    await NestFactory.create<NestExpressApplication>(AppModule),
  );
  // Split deploy (frontend on another origin): allow it via CORS_ORIGIN.
  // Empty = same-origin behind a shared proxy, no CORS headers needed.
  const corsOrigin = process.env.CORS_ORIGIN;
  if (corsOrigin) {
    app.enableCors({ origin: corsOrigin.split(',').map((o) => o.trim()) });
  }
  // MVP: uploaded images served by the app itself; nginx takes over in prod.
  app.useStaticAssets(UPLOADS_DIR, { prefix: UPLOADS_URL_PREFIX });
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
