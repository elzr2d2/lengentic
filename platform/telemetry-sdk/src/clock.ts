import { mulberry32 } from './prng';

/**
 * MVP_PLAN_V3 §17's Clock, injected so `occurredAt` is not wall-clock-dependent in a test.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

const REFERENCE_EPOCH_MS = Date.UTC(2026, 0, 1);
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function seededStartMs(seed: number): number {
  const random = mulberry32(seed)();
  return REFERENCE_EPOCH_MS + Math.floor(random * ONE_YEAR_MS);
}

/**
 * §17's seeded Clock. Two instances constructed with the same `seed` produce the identical
 * sequence of timestamps when `.now()` is called the same number of times — that is what
 * makes replaying a mock scenario byte-identical (`docs/decisions/0005-phase-2-wire-contract-gaps.md`
 * relies on the equivalent guarantee for `SeededIdGenerator`). Each call advances by
 * `stepMs` (default 1000) so a scenario with several events gets strictly increasing,
 * still-reproducible `occurredAt` values instead of every event sharing one instant.
 */
export class SeededClock implements Clock {
  private readonly startMs: number;

  private readonly stepMs: number;

  private ticks = 0;

  constructor(seed: number, options?: { readonly stepMs?: number }) {
    this.startMs = seededStartMs(seed);
    this.stepMs = options?.stepMs ?? 1_000;
  }

  now(): Date {
    const at = this.startMs + this.ticks * this.stepMs;
    this.ticks += 1;
    return new Date(at);
  }
}
