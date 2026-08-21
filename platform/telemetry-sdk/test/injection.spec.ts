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

  it('is independent of the real system clock', () => {
    const seeded = new SeededClock(3).now().getTime();
    const real = systemClock.now().getTime();

    // A seeded scenario is fixed at a reference epoch (2026-01-01 + a seed-derived offset
    // within one year), which is not "now" by any realistic system clock skew.
    expect(Math.abs(real - seeded)).toBeGreaterThan(1_000);
  });
});
