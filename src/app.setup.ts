import {
  BadRequestException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';

/**
 * Shared app configuration for main.ts and e2e tests:
 * /api/v1 prefix and strict body validation with a flat, contract-shaped
 * error message (Error.message is a string in the OpenAPI contract).
 */
export function setupApp<T extends INestApplication>(app: T): T {
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      exceptionFactory: (errors) =>
        new BadRequestException(
          errors
            .flatMap((error) => Object.values(error.constraints ?? {}))
            .join('; ') || 'Validation failed',
        ),
    }),
  );
  return app;
}
