import { describe, expect, it } from 'vitest';
import { RUN_STATUSES } from '../../schema/status';
import * as publicEntry from '../../index';
import {
  RUNS_LIST_DEFAULT_LIMIT,
  RUNS_LIST_MAX_LIMIT,
  RUN_VIEW_STATUSES,
  RunViewStatusSchema,
  RunsListQuerySchema,
} from '../../read';

/**
 * Seam: the read-model vocabulary itself, plus the query contract of `GET /v1/runs`.
 *
 * The two enum assertions below are the pair BACKLOG.md asks for — "either alone passes on
 * a wrong implementation". A view enum missing a stored status renders a real row as
 * nothing; a stored enum that has gained `STALE` means the derivation has leaked into
 * persistence, which ADR 0005 decision 4 forbids outright.
 */
describe('the read vocabulary and the stored enum', () => {
  it('can represent every STORED status', () => {
    // Expected source: platform/shared/schema/status.ts — the stored enum, read directly
    // rather than restated, so adding a stored status turns this red instead of silently
    // producing responses the schema rejects.
    for (const stored of RUN_STATUSES) {
      expect(RUN_VIEW_STATUSES).toContain(stored);
    }
  });

  it('keeps STALE out of the stored enum', () => {
    // MVP_PLAN_V3.md:592 — "Derived, not stored". ADR 0005 decision 4 — "Stored `status`
    // stays RUNNING forever". If this goes red, something has widened RUN_STATUSES and the
    // next writer will persist STALE.
    expect(RUN_STATUSES).not.toContain('STALE');
  });

  it('accepts STALE and rejects a status that is neither stored nor derived', () => {
    expect(RunViewStatusSchema.safeParse('STALE').success).toBe(true);
    expect(RunViewStatusSchema.safeParse('PENDING').success).toBe(false);
  });
});

describe('RunsListQuerySchema', () => {
  it('defaults an absent page to the first page', () => {
    const parsed = RunsListQuerySchema.parse({});

    expect(parsed).toStrictEqual({ limit: RUNS_LIST_DEFAULT_LIMIT, offset: 0 });
  });

  it('coerces the string values an HTTP query string actually delivers', () => {
    // Express hands every query parameter over as a string; a schema that only accepts
    // numbers here rejects every real request while passing every hand-written test.
    const parsed = RunsListQuerySchema.parse({ limit: '10', offset: '20' });

    expect(parsed).toStrictEqual({ limit: 10, offset: 20 });
  });

  it('rejects a limit above the cap rather than silently clamping it', () => {
    const parsed = RunsListQuerySchema.safeParse({ limit: String(RUNS_LIST_MAX_LIMIT + 1) });

    expect(parsed.success).toBe(false);
  });

  it('accepts a limit at exactly the cap', () => {
    expect(RunsListQuerySchema.parse({ limit: String(RUNS_LIST_MAX_LIMIT) }).limit).toBe(
      RUNS_LIST_MAX_LIMIT,
    );
  });

  it('rejects a zero limit and a negative offset', () => {
    expect(RunsListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(RunsListQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
  });

  it('rejects a non-numeric limit', () => {
    expect(RunsListQuerySchema.safeParse({ limit: 'all' }).success).toBe(false);
  });
});

describe('the root entry stays ingestion-only', () => {
  it('does not re-export the read vocabulary', () => {
    // `platform/telemetry-sdk` imports `@lengentic/shared`, and the SDK is the public
    // artifact. An ingestion-side author who can see `STALE` from the root entry is one
    // refactor away from persisting it — which ADR 0005 decision 4 forbids. The read model
    // is reachable only through `@lengentic/shared/read`.
    expect(Object.keys(publicEntry)).not.toContain('RUN_VIEW_STATUSES');
    expect(Object.keys(publicEntry)).not.toContain('RunViewStatusSchema');
    expect(Object.keys(publicEntry)).not.toContain('RunDetailViewSchema');
  });
});
