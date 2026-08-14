import 'reflect-metadata';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import type { Env } from './config/env.schema';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost).httpAdapter));
  app.enableShutdownHooks();

  // The Dashboard is a separate origin in every deployment shape we support, including
  // `docker compose up`. Authentication is explicitly out of MVP scope (§93), so there is
  // no credentialed request to protect here.
  app.enableCors({ origin: true });

  app.setGlobalPrefix('v1', { exclude: ['health'] });

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('API_PORT', { infer: true });

  await app.listen(port);
}

void bootstrap();
