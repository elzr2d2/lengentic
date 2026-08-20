/**
 * MVP_PLAN_V3 §17's Clock, injected so `occurredAt` is not wall-clock-dependent in a test.
 *
 * §17 also injects an IdGenerator and ships SeededClock/SeededIdGenerator implementations.
 * Those are `p2.sdk-injection`'s deliverable, not this packet's; this file deliberately
 * declares the §17 shape verbatim so that packet extends it rather than replacing it.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
