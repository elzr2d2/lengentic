import { describe, expect, it } from 'vitest';

import { envSchema, validateEnv } from './env.schema.js';

/**
 * OD-1 is a **resolved** open decision, not a free parameter:
 *
 *   MVP_PLAN_V3.md:2716  ### OD-1 — `STALE_RUN_THRESHOLD` value — **RESOLVED: 30 minutes**
 *   MVP_PLAN_V3.md:597   STALE_RUN_THRESHOLD = 30 minutes    configurable; see OD-1
 *
 * It shipped at 900_000 (15 minutes) in `env.schema.ts`, `.env`, `.env.example` and
 * `docker-compose.yml`, and nothing failed — no test pinned the resolved value, so the
 * drift was invisible to every gate. That is what this file exists to stop. The value is
 * still configurable; only the *default* is pinned, because the default is what a
 * deployment that sets nothing actually gets.
 *
 * The threshold decides which runs are excluded from all historical aggregation (§13), so
 * a wrong default silently changes every downstream number rather than failing loudly.
 */
const OD1_STALE_RUN_THRESHOLD_MS = 30 * 60 * 1000;

describe('envSchema — STALE_RUN_THRESHOLD_MS', () => {
  it('defaults to OD-1’s resolved 30 minutes when the deployment sets nothing', () => {
    const env = validateEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' });

    expect(env.STALE_RUN_THRESHOLD_MS).toBe(OD1_STALE_RUN_THRESHOLD_MS);
    expect(OD1_STALE_RUN_THRESHOLD_MS).toBe(1_800_000);
  });

  it('stays configurable — an explicit value overrides the default', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      STALE_RUN_THRESHOLD_MS: '60000',
    });

    expect(env.STALE_RUN_THRESHOLD_MS).toBe(60_000);
  });

  it('rejects a non-positive threshold rather than deriving every run as STALE', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        STALE_RUN_THRESHOLD_MS: '0',
      }),
    ).toThrow(/STALE_RUN_THRESHOLD_MS/);
  });

  it('reports every invalid variable at once, not just the first', () => {
    const result = envSchema.safeParse({ API_PORT: '70000', STALE_RUN_THRESHOLD_MS: '-1' });
    const paths = (result.success ? [] : result.error.issues).map((i) => i.path.join('.'));

    expect(paths).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'API_PORT', 'STALE_RUN_THRESHOLD_MS']),
    );
  });
});
