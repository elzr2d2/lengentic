/**
 * Seams under test (agreed against `MockProvider`'s public interface — `mock-provider.ts`
 * exports nothing else a caller is meant to reach):
 *
 *   1. `invoke()` is deterministic per `(seed, request)` — same in, byte-identical out,
 *      across separate `MockProvider` instances and regardless of call order.
 *   2. `delayMs` actually withholds resolution until the configured time has passed.
 *   3. `failureRate` / `alwaysFailSteps` actually decide whether `invoke()` rejects.
 *   4. `contextSeed` varies `contextVariation` independently of `seed`, which pins
 *      everything else.
 *
 * Negative fixture first, per knob: each knob gets a test proving the *absence* of its
 * effect at the default/zero setting before the test proving its presence, so a
 * MockProvider that ignored a knob entirely — the false-positive this skill exists to
 * catch — cannot pass by accident.
 *
 * Runner: Node's built-in `node:test` + `node:assert/strict`, run directly through `tsx`
 * (`pnpm exec tsx --test playground/providers/test/mock-provider.spec.ts`). `vitest` is
 * used by `platform/**`, but adding it here needs a "test" script + devDependency in
 * `playground/package.json`, which is outside this lane's `allowed_paths`
 * (`playground/providers/**`) — noted in the handoff, not worked around by widening scope.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MockProvider,
  MockProviderConfigError,
  MockProviderFailure,
  type MockProviderResponse,
} from '../mock-provider';
import { FakeScheduler } from './support/fake-scheduler';

void describe('MockProvider — determinism', () => {
  void it('produces byte-identical responses for the same seed and request, from separate instances', async () => {
    const a = new MockProvider({ seed: 42 });
    const b = new MockProvider({ seed: 42 });

    const first = await a.invoke({ step: 'plan' });
    const second = await b.invoke({ step: 'plan' });

    assert.deepStrictEqual(first, second);
  });

  void it('produces byte-identical responses across calls, whatever order the steps are issued in', async () => {
    const forward = new MockProvider({ seed: 7 });
    const reversed = new MockProvider({ seed: 7 });

    const forwardPlan = await forward.invoke({ step: 'plan' });
    const forwardExecute = await forward.invoke({ step: 'execute' });

    // Same instance, opposite call order — determinism must not depend on an internal
    // call counter that would make step "execute" see a different derived seed here than
    // it saw above.
    const reversedExecute = await reversed.invoke({ step: 'execute' });
    const reversedPlan = await reversed.invoke({ step: 'plan' });

    assert.deepStrictEqual(reversedPlan, forwardPlan);
    assert.deepStrictEqual(reversedExecute, forwardExecute);
  });

  void it('NEGATIVE — a different seed produces a different response (the seed is not ignored)', async () => {
    const a = new MockProvider({ seed: 1 });
    const b = new MockProvider({ seed: 2 });

    const first = await a.invoke({ step: 'plan' });
    const second = await b.invoke({ step: 'plan' });

    assert.notDeepStrictEqual(first, second);
  });

  void it('NEGATIVE — the same step at a different callIndex draws different randomness, not just an echoed field (callIndex reaches the RNG)', async () => {
    const provider = new MockProvider({ seed: 1 });

    const first = await provider.invoke({ step: 'plan', callIndex: 0 });
    const second = await provider.invoke({ step: 'plan', callIndex: 1 });

    assert.equal(first.callIndex, 0);
    assert.equal(second.callIndex, 1);

    // `detail` and `contextVariation.note` both echo `callIndex` verbatim, so comparing
    // them would pass even if the RNG itself ignored `callIndex` completely.
    // `contextVariation.variant` is `Math.floor(random() * 1_000_000)` and nothing else —
    // comparing it is what actually proves `callIndex` reaches the derived seed.
    assert.notEqual(first.contextVariation.variant, second.contextVariation.variant);
  });
});

void describe('MockProvider — configurable delay', () => {
  void it('NEGATIVE — with the default delay (0ms), invoke() resolves without the scheduler advancing', async () => {
    const scheduler = new FakeScheduler();
    const provider = new MockProvider({ seed: 1, scheduler });

    let resolved = false;
    void provider.invoke({ step: 'plan' }).then(() => {
      resolved = true;
    });

    await scheduler.advance(0);
    assert.equal(resolved, true);
  });

  void it('withholds resolution until the configured delay has elapsed on the injected scheduler', async () => {
    const scheduler = new FakeScheduler();
    const provider = new MockProvider({ seed: 1, delayMs: 100, scheduler });

    let resolved = false;
    void provider.invoke({ step: 'plan' }).then(() => {
      resolved = true;
    });

    await scheduler.advance(50);
    assert.equal(resolved, false, 'resolved before the configured 100ms delay elapsed');

    await scheduler.advance(50);
    assert.equal(resolved, true, 'did not resolve once the configured 100ms delay elapsed');
  });

  void it('samples a deterministic delay inside a configured [min, max] range', async () => {
    const scheduler = new FakeScheduler();
    const provider = new MockProvider({ seed: 3, delayMs: { min: 10, max: 20 }, scheduler });

    let resolved = false;
    void provider.invoke({ step: 'plan' }).then(() => {
      resolved = true;
    });

    await scheduler.advance(9);
    assert.equal(resolved, false, 'resolved before even the minimum of the configured range');

    await scheduler.advance(20);
    assert.equal(resolved, true, 'did not resolve once past the maximum of the configured range');
  });
});

void describe('MockProvider — configurable failure', () => {
  void it('NEGATIVE — with the default failureRate (0), a step never fails across many calls', async () => {
    const provider = new MockProvider({ seed: 1 });

    // Sequential on purpose: proving 50 independent derived-seed draws all clear
    // failureRate 0, not just one.
    for (let callIndex = 0; callIndex < 50; callIndex += 1) {
      await assert.doesNotReject(provider.invoke({ step: 'plan', callIndex }));
    }
  });

  void it('fails every call for a step at failureRate 1, with a MockProviderFailure naming the step and call', async () => {
    const provider = new MockProvider({ seed: 1, failureRate: 1 });

    await assert.rejects(provider.invoke({ step: 'plan', callIndex: 3 }), (error: unknown) => {
      if (!(error instanceof MockProviderFailure)) return false;
      assert.equal(error.step, 'plan');
      assert.equal(error.callIndex, 3);
      return true;
    });
  });

  void it('NEGATIVE — alwaysFailSteps only fails the named step, not an unrelated one', async () => {
    const provider = new MockProvider({ seed: 1, alwaysFailSteps: ['validate'] });

    await assert.doesNotReject(provider.invoke({ step: 'plan' }));
    await assert.rejects(provider.invoke({ step: 'validate' }), MockProviderFailure);
  });

  void it('rejects a config with failureRate outside [0, 1]', () => {
    assert.throws(() => new MockProvider({ seed: 1, failureRate: 1.5 }), MockProviderConfigError);
    assert.throws(() => new MockProvider({ seed: 1, failureRate: -0.1 }), MockProviderConfigError);
  });

  void it('rejects a config with an inverted delay range', () => {
    assert.throws(
      () => new MockProvider({ seed: 1, delayMs: { min: 20, max: 10 } }),
      MockProviderConfigError,
    );
  });
});

void describe('MockProvider — configurable context variation', () => {
  void it('NEGATIVE — without a distinct contextSeed, two instances with the same seed produce identical contextVariation', async () => {
    const a = new MockProvider({ seed: 9 });
    const b = new MockProvider({ seed: 9 });

    const first = await a.invoke({ step: 'plan' });
    const second = await b.invoke({ step: 'plan' });

    assert.deepStrictEqual(first.contextVariation, second.contextVariation);
  });

  void it('varies contextVariation under a different contextSeed while detail and step stay pinned to seed', async () => {
    const pinned: MockProviderResponse[] = [];
    for (const contextSeed of [100, 200, 300]) {
      const provider = new MockProvider({ seed: 9, contextSeed });
      pinned.push(await provider.invoke({ step: 'plan' }));
    }

    const [first, second, third] = pinned;
    // Guards against the array coming back short, which would otherwise let every
    // assertion below pass vacuously on `undefined`.
    assert.ok(first && second && third, 'expected exactly three responses');

    // Same `seed` for all three: `detail` (derived from `seed`) must be identical throughout.
    assert.equal(first.detail, second.detail);
    assert.equal(second.detail, third.detail);

    // Different `contextSeed` for each: `contextVariation` must differ across all three.
    assert.notDeepStrictEqual(first.contextVariation, second.contextVariation);
    assert.notDeepStrictEqual(second.contextVariation, third.contextVariation);
  });
});

void describe('MockProvider — misuse', () => {
  void it('rejects invoke() with an empty step instead of throwing synchronously', async () => {
    const provider = new MockProvider({ seed: 1 });
    await assert.rejects(provider.invoke({ step: '' }), MockProviderConfigError);
  });
});

void describe('MockProvider — seed validation (R4: seed aliasing)', () => {
  // `deriveSeed`/`mulberry32` fold `seed` through `ToInt32` (`| 0`), which is lossless only
  // inside the 32-bit signed integer range. Outside it, distinct seeds a caller reasonably
  // believes are different collapse to the same internal value —
  // `.artifacts/evidence/3/wave2-gate/validator/raw/determinism-seed-collision.txt` measured
  // this for the sibling `createSeededComponents`; the same root cause applies here.
  void it('NEGATIVE — a valid boundary seed (32-bit min/max) is accepted', () => {
    assert.doesNotThrow(() => new MockProvider({ seed: -(2 ** 31) }));
    assert.doesNotThrow(() => new MockProvider({ seed: 2 ** 31 - 1 }));
  });

  void it('rejects seed: NaN, which would otherwise be byte-identical to seed 0', () => {
    assert.throws(() => new MockProvider({ seed: Number.NaN }), MockProviderConfigError);
  });

  void it('rejects a non-integer seed', () => {
    assert.throws(() => new MockProvider({ seed: 1.5 }), MockProviderConfigError);
  });

  void it('rejects a seed outside the 32-bit signed integer range', () => {
    assert.throws(() => new MockProvider({ seed: 2 ** 32 + 1 }), MockProviderConfigError);
    assert.throws(() => new MockProvider({ seed: 1e21 }), MockProviderConfigError);
  });

  void it('rejects an out-of-range contextSeed, independently of a valid seed', () => {
    assert.throws(
      () => new MockProvider({ seed: 1, contextSeed: 1 + 2 ** 32 }),
      MockProviderConfigError,
    );
  });
});
