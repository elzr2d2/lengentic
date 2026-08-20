import { Injectable } from '@nestjs/common';

/**
 * The server clock, as an injected dependency rather than an ambient one.
 *
 * `MVP_PLAN_V3.md:595` defines STALE as `now - lastEventAt > STALE_RUN_THRESHOLD`, so `now`
 * is an *input* to a domain rule, not an implementation detail. Reading `Date.now()` inside
 * that rule would leave only two ways to test the thirty-minute boundary: sleep past it
 * (forbidden — `docs/ENGINEERING_STANDARDS.md` TEST-1) or write a row with a fabricated
 * `lastEventAt` and assert approximately (a boundary case that cannot be hit exactly).
 *
 * One implementation ships. The seam exists because a test double is a second real consumer
 * (the anti-overengineering gate's question 4), not in anticipation of a second clock.
 */
export interface Clock {
  now(): Date;
}

/** Nest provider token. `Clock` is an interface, so it has no runtime value to inject by. */
export const CLOCK = Symbol('Clock');

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
