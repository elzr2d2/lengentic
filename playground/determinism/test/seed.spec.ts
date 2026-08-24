/**
 * Uses Node's built-in test runner (`node:test`/`node:assert`), not vitest: `playground`
 * declares `@types/node` already (for `node:test` types) but no `vitest` dependency, and
 * adding one is a `playground/package.json` edit outside this lane's `allowed_paths`
 * (`playground/determinism/**`) — see `.artifacts/backlog/pending.md`. Everything else
 * about these tests — seam, independent expected values, mutation-checked — is unchanged
 * from the project's usual vitest idiom.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SeededClock, SeededIdGenerator } from '../../index';

import { createSeededComponents, SeededComponentsConfigError } from '../seed';

/**
 * Seam: `createSeededComponents`' own contract — one seed in, one matched `Clock` +
 * `IdGenerator` pair out. The SDK already proves `SeededClock`/`SeededIdGenerator` are
 * individually deterministic (`platform/telemetry-sdk/test/injection.spec.ts`); what this
 * file has to prove is that the Playground's wrapper does not lose that guarantee — a
 * generator that ignored its seed, or a wrapper that memoized one pair across two callers,
 * would both pass a naive "it returns something" test and fail every assertion below.
 */
void describe('createSeededComponents', () => {
  // Negative fixture first (CLAUDE.md ## Product claims, test-at-seams skill): a wrapper
  // that silently returned a fixed pair regardless of `seed` must go red here.
  void it('produces a different id and a different starting instant for a different seed', () => {
    const a = createSeededComponents(1);
    const b = createSeededComponents(2);

    assert.notStrictEqual(b.idGenerator.next(), a.idGenerator.next());
    assert.notStrictEqual(b.clock.now().getTime(), a.clock.now().getTime());
  });

  void it('produces the identical id and timestamp sequence for two pairs built from the same seed', () => {
    const a = createSeededComponents(42);
    const b = createSeededComponents(42);

    const idsA = [a.idGenerator.next(), a.idGenerator.next(), a.idGenerator.next()];
    const idsB = [b.idGenerator.next(), b.idGenerator.next(), b.idGenerator.next()];
    assert.deepStrictEqual(idsB, idsA);

    const timesA = [a.clock.now().getTime(), a.clock.now().getTime()];
    const timesB = [b.clock.now().getTime(), b.clock.now().getTime()];
    assert.deepStrictEqual(timesB, timesA);
  });

  void it('never repeats an id within one pair', () => {
    const { idGenerator } = createSeededComponents(7);
    const ids = Array.from({ length: 20 }, () => idGenerator.next());

    assert.strictEqual(new Set(ids).size, ids.length);
  });

  void it('never goes backwards, and honours a configured stepMs', () => {
    const { clock } = createSeededComponents(9, { stepMs: 250 });

    const first = clock.now().getTime();
    const second = clock.now().getTime();
    const third = clock.now().getTime();

    assert.strictEqual(second - first, 250);
    assert.strictEqual(third - second, 250);
  });

  void it('returns a fresh pair per call, not one shared across callers', () => {
    // If createSeededComponents cached a pair per seed, `b` below would receive the SAME
    // clock/idGenerator `a` already advanced, so its first reading would equal `a`'s SECOND
    // reading instead of a fresh instance's first. The expected values come from
    // independently constructed SDK instances, not from `a`, so this cannot pass by
    // circularity.
    const a = createSeededComponents(3);
    a.clock.now();
    a.idGenerator.next();

    const expectedFirstTick = new SeededClock(3).now().getTime();
    const expectedFirstId = new SeededIdGenerator(3).next();

    const b = createSeededComponents(3);
    assert.strictEqual(b.clock.now().getTime(), expectedFirstTick);
    assert.strictEqual(b.idGenerator.next(), expectedFirstId);
  });
});

void describe('createSeededComponents — seed validation (R4: seed aliasing)', () => {
  // Root cause: `mulberry32`'s `let state = seed | 0` (`platform/telemetry-sdk/src/prng.ts`)
  // is a lossless `ToInt32` only inside the 32-bit signed integer range. Outside it, two
  // seeds a caller reasonably believes are distinct collapse to the same internal state —
  // measured directly in
  // `.artifacts/evidence/3/wave2-gate/validator/raw/determinism-seed-collision.txt`
  // (`-1` vs `Number.MAX_SAFE_INTEGER`, `1` vs `1 + 2**32`). Validated at this package's own
  // boundary rather than in `platform/telemetry-sdk` (out of scope for this repair).
  void it('NEGATIVE — a valid boundary seed (32-bit min/max) is accepted', () => {
    assert.doesNotThrow(() => createSeededComponents(-(2 ** 31)));
    assert.doesNotThrow(() => createSeededComponents(2 ** 31 - 1));
  });

  void it('rejects a seed outside the 32-bit signed integer range', () => {
    assert.throws(
      () => createSeededComponents(Number.MAX_SAFE_INTEGER),
      SeededComponentsConfigError,
    );
    assert.throws(() => createSeededComponents(1 + 2 ** 32), SeededComponentsConfigError);
  });

  void it('rejects a non-integer or non-finite seed', () => {
    assert.throws(() => createSeededComponents(1.5), SeededComponentsConfigError);
    assert.throws(() => createSeededComponents(Number.NaN), SeededComponentsConfigError);
  });

  void it('two seeds that previously collided (-1 and Number.MAX_SAFE_INTEGER) no longer both succeed', () => {
    // -1 is in range and must still work; MAX_SAFE_INTEGER is the one that must now be
    // rejected instead of silently aliasing to it.
    const inRange = createSeededComponents(-1);
    assert.ok(inRange.idGenerator.next().length > 0);
    assert.throws(
      () => createSeededComponents(Number.MAX_SAFE_INTEGER),
      SeededComponentsConfigError,
    );
  });
});
