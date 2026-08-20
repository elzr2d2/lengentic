import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';

/**
 * `STALE_RUN_THRESHOLD_MS`, resolved once at module construction and injected as a plain
 * number.
 *
 * ADR 0005 decision 4 requires the value already in `config/env.schema.ts` to be *consumed,
 * not reintroduced*; OD-1 requires it to stay configuration rather than a constant. Injecting
 * the number rather than `ConfigService` means `RunsService` can be constructed in a unit test
 * with an explicit threshold, so a boundary case is a literal in the test rather than an
 * environment variable the test has to arrange.
 */
export const STALE_THRESHOLD_MS = Symbol('StaleThresholdMs');

export const staleThresholdProvider: Provider = {
  provide: STALE_THRESHOLD_MS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): number =>
    config.get('STALE_RUN_THRESHOLD_MS', { infer: true }),
};
