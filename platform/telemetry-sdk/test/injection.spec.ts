import { describe, expect, it } from 'vitest';

import { SeededClock, SeededIdGenerator, systemClock, systemIdGenerator } from '../src/index';

/**
 * Seam: §17's `Clock` and `IdGenerator`. The contract is "same seed → byte-identical
 * telemetry" (`MVP_PLAN_V3.md` §17), which is a claim about two *separate* instances built
 * from the same seed producing the same sequence — not merely that a single instance is
 * internally consistent. Every "identical" assertion below is paired with a "differs"
 * assertion sourced from a different seed or a different call, so a constant-returning
 * fake cannot pass by accident.
 */
describe('SeededIdGenerator', () => {
  it('produces the identical sequence of ids from two instances built with the same seed', () => {
    const a = new SeededIdGenerator(42);
    const b = new SeededIdGenerator(42);

    const sequenceA = [a.next(), a.next(), a.next()];
    const sequenceB = [b.next(), b.next(), b.next()];

    expect(sequenceB).toEqual(sequenceA);
  });

  it('produces a different sequence for a different seed', () => {
    const a = new SeededIdGenerator(1);
    const b = new SeededIdGenerator(2);

    expect(b.next()).not.toBe(a.next());
  });

  it('never repeats an id within one sequence', () => {
    const generator = new SeededIdGenerator(7);
    const ids = [generator.next(), generator.next(), generator.next(), generator.next()];

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is not the runtime generator wearing a disguise', () => {
    // Real UUIDv7 always sets the version nibble to 7; the seeded generator marks its ids
    // with `f` instead, so a scenario id can never collide in shape with a production one.
    const seeded = new SeededIdGenerator(1).next();
    const real = systemIdGenerator.next();

    expect(seeded[14]).toBe('f');
    expect(real[14]).toBe('7');
  });
});

describe('SeededClock', () => {
  it('produces the identical sequence of timestamps from two instances built with the same seed', () => {
    const a = new SeededClock(42);
    const b = new SeededClock(42);

    const sequenceA = [a.now().toISOString(), a.now().toISOString(), a.now().toISOString()];
    const sequenceB = [b.now().toISOString(), b.now().toISOString(), b.now().toISOString()];

    expect(sequenceB).toEqual(sequenceA);
  });

  it('produces a different starting instant for a different seed', () => {
    const a = new SeededClock(1);
    const b = new SeededClock(2);

    expect(b.now().getTime()).not.toBe(a.now().getTime());
  });

  it('advances strictly forward on each call, by the configured step', () => {
    const clock = new SeededClock(9, { stepMs: 5_000 });

    const first = clock.now().getTime();
    const second = clock.now().getTime();

    expect(second - first).toBe(5_000);
  });

  it('is a function of the seed alone, not of when the test runs', () => {
    // The property that actually holds. The previous form of this test asserted the seeded
    // instant was more than a second away from `Date.now()`, which is a statement about
    // today's date rather than about the design: `clock.ts` places every seeded start inside
    // [2026-01-01, 2027-01-01), a window that CONTAINS the present, and seeds landing within
    // a second of now are possible in principle. Pinning the exact instant is the structural
    // claim — this assertion holds identically on any machine, on any date, forever.
    const clock = new SeededClock(3);

    expect(clock.now().toISOString()).toBe('2026-09-20T21:11:11.853Z');
    expect(clock.now().toISOString()).toBe('2026-09-20T21:11:12.853Z');
  });

  it('is the half of the seam that does not track the host clock', () => {
    // Paired with the assertion above so neither claim stands alone: the runtime default
    // DOES track the host clock, which is exactly what the seeded implementation replaces.
    const before = Date.now();
    const real = systemClock.now().getTime();
    const after = Date.now();

    expect(real).toBeGreaterThanOrEqual(before);
    expect(real).toBeLessThanOrEqual(after);
  });

  it('does not read the host clock at all', () => {
    // The independence claim, made structurally rather than by comparing instants: replace
    // the global `Date.now` with a value nothing in [2026-01-01, 2027-01-01) could produce
    // and the seeded output does not move.
    const realDateNow = Date.now;
    Date.now = () => 0;
    try {
      expect(new SeededClock(3).now().toISOString()).toBe('2026-09-20T21:11:11.853Z');
    } finally {
      Date.now = realDateNow;
    }
  });
});
