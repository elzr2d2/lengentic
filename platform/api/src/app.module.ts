import type { IncomingMessage } from 'node:http';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv, type Env } from './config/env.schema';
import { DecisionsModule } from './decisions/decisions.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { RunsModule } from './runs/runs.module';
import { TelemetryModule } from './telemetry/telemetry.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),

    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        // Human-readable locally, newline-delimited JSON everywhere else. Structured logs
        // nobody can read during development get turned off during development.
        //
        // Spread rather than `transport: undefined` — under `exactOptionalPropertyTypes`
        // an explicit `undefined` is not the same as an absent key, and pino treats the
        // two differently too.
        const pretty =
          config.get('NODE_ENV', { infer: true }) === 'development'
            ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
            : {};

        return {
          pinoHttp: {
            level: config.get('LOG_LEVEL', { infer: true }),
            ...pretty,

            // The telemetry API receives other systems' payloads. Anything that could
            // carry a credential is removed before it reaches a log sink — the same
            // concern MVP_PLAN.md §58 addresses on the SDK side.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["x-api-key"]',
                'res.headers["set-cookie"]',
              ],
              remove: true,
            },

            autoLogging: {
              // Every orchestrator and compose healthcheck polls /health on an interval.
              // Logging each one buries real traffic.
              ignore: (req: IncomingMessage) => req.url === '/health',
            },
          },
        };
      },
    }),

    PrismaModule,
    HealthModule,
    TelemetryModule,
    RunsModule,

    // Registered although nothing injects `DecisionsService` yet: routing a
    // `decision.outcome_attested` event out of an ingest batch means changing
    // `src/telemetry/**`, which belongs to another node (`entityKindOf` returns `null` for
    // the type today, so the event is rejected as `EVENT_TYPE_NOT_INGESTIBLE` before it
    // could reach the service). Leaving the module unregistered would make the attestation
    // path unbuildable at runtime rather than merely uncalled — a different and worse state
    // to hand the node that lands the routing.
    DecisionsModule,
  ],
})
export class AppModule {}
