import { describe, expect, it } from 'vitest';
import { deriveRunViewStatus } from './stale';

/**
 * Seam: `deriveRunViewStatus` — a pure function, the whole of the STALE rule, observed
 * without a database, a clock or a request. `now` is an input, never `Date.now()`, so the
 * boundary cases below are exact rather than approximately-slept-for (TEST-1).
 *
 * Expected values are sourced from the plan text, not from the implementation:
 *
 *   MVP_PLAN_V3.md:595  STALE = status == RUNNING AND now - lastEventAt > STALE_RUN_THRESHOLD
 *   MVP_PLAN_V3.md:597  STALE_RUN_THRESHOLD = 30 minutes    configurable; see OD-1
 *
 * Two literals follow from that line and are used throughout: the comparison is STRICTLY
 * greater than (so exactly-at-threshold is not stale), and the guard is `status == RUNNING`
 * (so a terminal status is never reconsidered, however old the run is).
 *
 * The instants below are hand-computed UTC arithmetic, not values read back from the code:
 *   now          = 2026-08-21T12:00:00.000Z
 *   threshold    = 1_800_000 ms  (30 minutes: 30 * 60 * 1000)
 *   12:00:00.000 - 11:30:00.000  = 1_800_000 ms exactly  -> NOT stale
 *   12:00:00.000 - 11:29:59.999  = 1_800_001 ms          -> stale
 */
const NOW = new Date('2026-08-21T12:00:00.000Z');
const THIRTY_MINUTES_MS = 1_800_000;

describe('deriveRunViewStatus — a run that is NOT stale', () => {
  // The negative cases come first on purpose: a derivation that reports STALE too eagerly
  // marks live runs dead and silently drops them from every historical aggregation
  // (MVP_PLAN_V3.md:599). That is the expensive failure, so it is the one pinned first.

  it('reports RUNNING for a run whose last event is well inside the threshold', () => {
    const status = deriveRunViewStatus({
      storedStatus: 'RUNNING',
      lastEventAt: new Date('2026-08-21T11:59:00.000Z'), // idle 60_000 ms
      now: NOW,
      staleThresholdMs: THIRTY_MINUTES_MS,
    });

    expect(status).toBe('RUNNING');
  });

  it('reports RUNNING at exactly the threshold, because the plan says strictly greater', () => {
    const status = deriveRunViewStatus({
      storedStatus: 'RUNNING',
      lastEventAt: new Date('2026-08-21T11:30:00.000Z'), // idle 1_800_000 ms exactly
      now: NOW,
      staleThresholdMs: THIRTY_MINUTES_MS,
    });

    expect(status).toBe('RUNNING');
  });

  it('reports COMPLETED for a completed run whose last event is ancient', () => {
    // `status == RUNNING` is a conjunct of the rule, not a formality. A finished run is
    // silent forever by definition; reporting it STALE would make every historical run in
    // the system decay into STALE after thirty minutes.
    const status = deriveRunViewStatus({
      storedStatus: 'COMPLETED',
      lastEventAt: new Date('2025-01-01T00:00:00.000Z'),
      now: NOW,
      staleThresholdMs: THIRTY_MINUTES_MS,
    });

    expect(status).toBe('COMPLETED');
  });

  it('reports FAILED for a failed run whose last event is ancient', () => {
    const status = deriveRunViewStatus({
      storedStatus: 'FAILED',
      lastEventAt: new Date('2025-01-01T00:00:00.000Z'),
      now: NOW,
      staleThresholdMs: THIRTY_MINUTES_MS,
    });

    expect(status).toBe('FAILED');
  });

  it('reports RUNNING when lastEventAt is ahead of the server clock', () => {
    // `lastEventAt` is the server clock (§13), so this needs a clock step backwards across
    // replicas to happen at all — but a negative idle must not wrap into STALE.
    const status = deriveRunViewStatus({
      storedStatus: 'RUNNING',
      lastEventAt: new Date('2026-08-21T12:05:00.000Z'), // idle -300_000 ms
      now: NOW,
      staleThresholdMs: THIRTY_MINUTES_MS,
    });

    expect(status).toBe('RUNNING');
  });
});

describe('deriveRunViewStatus — a run that IS stale', () => {
  it('reports STALE one millisecond past the threshold', () => {
    const status = deriveRunViewStatus({
      storedStatus: 'RUNNING',
      lastEventAt: new Date('2026-08-21T11:29:59.999Z'), // idle 1_800_001 ms
      now: NOW,
      staleThresholdMs: THIRTY_MINUTES_MS,
    });

    expect(status).toBe('STALE');
  });

  it('reports STALE for a run killed hours ago', () => {
    // The Phase 2 DoD line this exists for: "Killing the script mid-run leaves a Run that
    // derives as STALE" (MVP_PLAN_V3.md:1609). A killed script never sends `run.completed`,
    // so the row stays RUNNING and only the elapsed silence distinguishes it from a live run.
    const status = deriveRunViewStatus({
      storedStatus: 'RUNNING',
      lastEventAt: new Date('2026-08-21T08:00:00.000Z'), // idle 14_400_000 ms
      now: NOW,
      staleThresholdMs: THIRTY_MINUTES_MS,
    });

    expect(status).toBe('STALE');
  });

  it('honours a raised threshold instead of a hardcoded thirty minutes', () => {
    // OD-1: "held as configuration rather than a constant so a deployment with slower
    // agents can raise it without a code change". The same instants that are STALE above
    // are RUNNING under a four-hour threshold.
    const fourHoursMs = 14_400_000;

    expect(
      deriveRunViewStatus({
        storedStatus: 'RUNNING',
        lastEventAt: new Date('2026-08-21T08:00:00.000Z'), // idle 14_400_000 ms exactly
        now: NOW,
        staleThresholdMs: fourHoursMs,
      }),
    ).toBe('RUNNING');

    expect(
      deriveRunViewStatus({
        storedStatus: 'RUNNING',
        lastEventAt: new Date('2026-08-21T07:59:59.999Z'), // idle 14_400_001 ms
        now: NOW,
        staleThresholdMs: fourHoursMs,
      }),
    ).toBe('STALE');
  });
});
