import 'reflect-metadata';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { configureBodyParser } from './common/configure-body-parser';
import type { Env } from './config/env.schema';

async function bootstrap(): Promise<void> {
  // `bodyParser: false` + `configureBodyParser` below is deliberate, not decoration: Nest's
  // default parser is capped at 100kb, and calling `useBodyParser` a second time on TOP of
  // the default would still leave that 100kb parser as the first one in the middleware
  // chain, rejecting anything between 100kb and OD-2's 5MB before this package's own limit
  // ever runs. Disabling the default is the only way to guarantee exactly one limit is in
  // force, and that it is this one.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });

  configureBodyParser(app);

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
