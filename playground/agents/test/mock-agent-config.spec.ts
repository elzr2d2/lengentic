/**
 * `MockAgent`'s own constructor-time validation — separate from `MockProvider`'s (already
 * covered by `playground/providers/test/mock-provider.spec.ts`, "R4: seed aliasing") and
 * from `evaluateExecutionStrategy`'s (`playground/strategy/evaluator.test.ts`). This file
 * only exercises what `MockAgent` itself checks before either of those ever runs:
 * `tasks` and `availableConcurrency`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MockAgent, MockAgentConfigError } from '../index';
import { MockProviderConfigError } from '../../providers';

void describe('MockAgent — config validation', () => {
  void it('NEGATIVE — a config with the default task list and default concurrency is accepted', () => {
    assert.doesNotThrow(() => new MockAgent({ seed: 1 }));
  });

  void it('rejects an empty tasks array', () => {
    assert.throws(() => new MockAgent({ seed: 1, tasks: [] }), MockAgentConfigError);
  });

  void it('rejects a task with an empty name', () => {
    assert.throws(() => new MockAgent({ seed: 1, tasks: [{ name: '' }] }), MockAgentConfigError);
  });

  void it('rejects duplicate task names', () => {
    assert.throws(
      () => new MockAgent({ seed: 1, tasks: [{ name: 'a' }, { name: 'a' }] }),
      MockAgentConfigError,
    );
  });

  void it('rejects a non-integer availableConcurrency', () => {
    assert.throws(
      () => new MockAgent({ seed: 1, availableConcurrency: 1.5 }),
      MockAgentConfigError,
    );
  });

  void it('rejects a negative availableConcurrency', () => {
    assert.throws(() => new MockAgent({ seed: 1, availableConcurrency: -1 }), MockAgentConfigError);
  });

  void it('NEGATIVE — availableConcurrency of 0 is a valid (if useless) non-negative integer', () => {
    assert.doesNotThrow(() => new MockAgent({ seed: 1, availableConcurrency: 0 }));
  });

  void it('rejects an out-of-range seed synchronously from the constructor, not only when run() is awaited', () => {
    // `MockProvider` is built eagerly in `MockAgent`'s own constructor precisely so this
    // fails fast (see the doc comment on `MockAgent.provider`) — this is the seam that
    // proves it, not a duplicate of `MockProvider`'s own seed-range test matrix
    // (`playground/providers/test/mock-provider.spec.ts`).
    assert.throws(() => new MockAgent({ seed: 2 ** 32 + 1 }), MockProviderConfigError);
  });
});
