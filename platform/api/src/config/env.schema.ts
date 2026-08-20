import { z } from 'zod';

/**
 * Environment validation (MVP_PLAN.md §32).
 *
 * Fails at boot, not at the first request that needs the value. A misconfigured service
 * that starts successfully and breaks under load is strictly worse than one that refuses
 * to start.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  /**
   * A RUNNING run with no event newer than this derives as STALE and is excluded from all
   * historical aggregation (§39). Consumed from Phase 2 onward; validated from Phase 1 so
   * a deployment cannot be missing it later.
   */
  STALE_RUN_THRESHOLD_MS: z.coerce.number().int().positive().default(1_800_000),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Reports every invalid variable at once.
 *
 * Failing on the first problem turns a misconfigured deployment into a sequence of
 * restarts, each revealing one more missing value.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('\n');

  throw new Error(`Invalid environment configuration:\n${details}`);
}
