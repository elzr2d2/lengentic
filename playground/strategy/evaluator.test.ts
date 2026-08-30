/**
 * Tests for `evaluateExecutionStrategy` (`playground/strategy/index.ts`).
 *
 * Seam under test: the module's one public function, called exactly as any orchestrator
 * code would call it — `evaluateExecutionStrategy(input)` — never the internal parsing or
 * rule helpers in `./evaluator`, which are not exported.
 *
 * Expected values are sourced from the plan section verbatim (`MVP_PLAN_V3.md` §29's twelve
 * numbered conditions and the Phase 3 Definition of Done checkboxes carried into the work
 * packet), not from running the implementation and copying its output. Reason/blocker codes
 * are this module's own vocabulary (the plan requires "a fixed code", not a specific string),
 * so asserting an exact code string is a stability check on this module's contract, not a
 * circular readback of its arithmetic.
 *
 * No test framework dependency exists in `playground/package.json` (a sibling Phase 3 lane
 * hit this first; see the work packet). Node's built-in test runner is used instead, run as:
 *
 *   node --import tsx --test playground/strategy/evaluator.test.ts
 *
 * Negative fixtures — the shapes that must never produce `parallel` — are written before the
 * positive path, per `CLAUDE.md` "When implementing analyzers, write the negative fixtures
 * before the positive path."
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EVALUATOR_VERSION, evaluateExecutionStrategy } from './index';
import type { AwarenessContext, Readiness, Resources, Risk, TriBool } from './types';

/**
 * A context in which every one of the twelve conditions holds, so any single override below
 * isolates exactly one rule. `structuredClone` guards against a test mutating a shared
 * literal and leaking state into another test (TEST determinism concerns in `test-at-seams`).
 */
function eligibleContext(
  overrides: {
    topology?: Partial<AwarenessContext['topology']>;
    resources?: Partial<Resources>;
    readiness?: Partial<Readiness>;
    limits?: Partial<AwarenessContext['limits']>;
    risk?: Partial<Risk>;
  } = {},
): AwarenessContext {
  const base: AwarenessContext = {
    schemaVersion: 1,
    topology: {
      taskCount: 2,
      runnableTaskCount: 2,
      dependencyCount: 0,
      unresolvedDependencyCount: 0,
      dependenciesKnown: true,
    },
    resources: {
      claimedResourceCount: 0,
      conflictingResourceCount: 0,
      conflictsChecked: true,
      sharedMutableState: false,
    },
    readiness: {
      requirementsComplete: true,
      contractsStable: true,
      validationAvailable: true,
      independentlyValidatable: true,
      independentlyReversible: true,
    },
    limits: {
      requestedConcurrency: 2,
      availableConcurrency: 2,
    },
    risk: {
      level: 'low',
      reasons: [],
    },
  };
  const clone = structuredClone(base);
  return {
    ...clone,
    topology: { ...clone.topology, ...overrides.topology },
    resources: { ...clone.resources, ...overrides.resources },
    readiness: { ...clone.readiness, ...overrides.readiness },
    limits: { ...clone.limits, ...overrides.limits },
    risk: { ...clone.risk, ...overrides.risk },
  };
}

function blockerCodes(result: ReturnType<typeof evaluateExecutionStrategy>): string[] {
  return result.blockers.map((b) => b.code);
}

void describe('evaluateExecutionStrategy — unknown/malformed input forces sequential', () => {
  void test('undefined input', () => {
    const result = evaluateExecutionStrategy(undefined);
    assert.equal(result.mode, 'sequential');
    assert.equal(result.eligible, false);
    assert.deepEqual(blockerCodes(result), ['context-invalid']);
  });

  void test('empty object', () => {
    const result = evaluateExecutionStrategy({});
    assert.equal(result.mode, 'sequential');
    assert.equal(result.eligible, false);
    assert.deepEqual(blockerCodes(result), ['context-invalid']);
  });

  void test('wrong schemaVersion', () => {
    const result = evaluateExecutionStrategy({ ...eligibleContext(), schemaVersion: 2 });
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['context-invalid']);
  });

  void test('missing a required top-level section', () => {
    const ctx = eligibleContext() as unknown as Record<string, unknown>;
    delete ctx.limits;
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['context-invalid']);
  });

  void test('unrecognised value for a tri-state field invalidates the context, not just the field', () => {
    const ctx = eligibleContext() as unknown as { resources: Record<string, unknown> };
    ctx.resources.sharedMutableState = 'yes'; // not true | false | 'unknown'
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['context-invalid']);
  });

  void test('unrecognised risk level', () => {
    const ctx = eligibleContext() as unknown as { risk: Record<string, unknown> };
    ctx.risk.level = 'catastrophic';
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['context-invalid']);
  });

  const triBoolFields: { section: 'resources' | 'readiness'; field: string; code: string }[] = [
    { section: 'resources', field: 'sharedMutableState', code: 'unsafe-shared-mutable-state' },
    { section: 'readiness', field: 'requirementsComplete', code: 'requirements-incomplete' },
    { section: 'readiness', field: 'contractsStable', code: 'contracts-unstable' },
    { section: 'readiness', field: 'validationAvailable', code: 'validation-unavailable' },
    {
      section: 'readiness',
      field: 'independentlyValidatable',
      code: 'not-independently-validatable',
    },
    {
      section: 'readiness',
      field: 'independentlyReversible',
      code: 'not-independently-reversible',
    },
  ];

  for (const { section, field, code } of triBoolFields) {
    void test(`${section}.${field} = 'unknown' forces sequential (blocker: ${code})`, () => {
      const ctx = eligibleContext({ [section]: { [field]: 'unknown' as TriBool } });
      const result = evaluateExecutionStrategy(ctx);
      assert.equal(result.mode, 'sequential');
      assert.equal(result.eligible, false);
      assert.ok(
        blockerCodes(result).includes(code),
        `expected blocker "${code}", got ${JSON.stringify(blockerCodes(result))}`,
      );
    });
  }

  void test('one runnable task', () => {
    const ctx = eligibleContext({ topology: { runnableTaskCount: 1 } });
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['insufficient-runnable-tasks']);
  });

  void test('zero runnable tasks', () => {
    const ctx = eligibleContext({ topology: { runnableTaskCount: 0 } });
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.ok(blockerCodes(result).includes('insufficient-runnable-tasks'));
  });

  void test('an unresolved dependency', () => {
    const ctx = eligibleContext({
      topology: { dependencyCount: 1, unresolvedDependencyCount: 1 },
    });
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['unresolved-dependencies']);
  });

  void test('an inconsistent dependency graph is "not known", distinct from merely unresolved', () => {
    const ctx = eligibleContext({
      topology: { dependencyCount: 1, unresolvedDependencyCount: 2 },
    });
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.ok(blockerCodes(result).includes('dependencies-not-known'));
  });

  void test('dependenciesKnown = "unknown" forces sequential even when the counts look clean', () => {
    // The exact shape that used to slip through: dependencyCount and unresolvedDependencyCount
    // both 0 (a "clean" graph by count alone), but nobody ever verified it.
    const ctx = eligibleContext({ topology: { dependenciesKnown: 'unknown' } });
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.equal(result.eligible, false);
    assert.deepEqual(blockerCodes(result), ['dependencies-not-known']);
  });

  void test('dependenciesKnown = false forces sequential', () => {
    const ctx = eligibleContext({ topology: { dependenciesKnown: false } });
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['dependencies-not-known']);
  });

  void test('missing dependenciesKnown entirely invalidates the whole context (malformed shape, not a default pass)', () => {
    const ctx = eligibleContext() as unknown as { topology: Record<string, unknown> };
    delete ctx.topology.dependenciesKnown;
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['context-invalid']);
  });

  void test('runnableTaskCount exceeding taskCount is a structurally impossible topology, not a passing one', () => {
    // Reproduces the validator's FINDING A: taskCount is validated but was read by no rule,
    // so this shape used to return mode:"parallel".
    const ctx = eligibleContext({ topology: { taskCount: 1, runnableTaskCount: 5 } });
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['context-invalid']);
  });

  void test('a context built by Object.create (zero own properties) is not accepted as valid', () => {
    // Reproduces the validator's FINDING B / reviewer's S11: prototype-inherited fields
    // resolve through plain property access exactly like own fields do, so a naive parser
    // accepts this. Not reachable through JSON.parse; reachable through object composition.
    const evil = Object.create(eligibleContext()) as unknown;
    const result = evaluateExecutionStrategy(evil);
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['context-invalid']);
  });

  void test('conflicting resource claims', () => {
    const ctx = eligibleContext({ resources: { conflictingResourceCount: 1 } });
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['conflicting-resource-claims']);
  });

  void test('conflictsChecked = "unknown" forces sequential even when conflictingResourceCount is 0', () => {
    const ctx = eligibleContext({ resources: { conflictsChecked: 'unknown' } });
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['conflicting-resource-claims']);
  });

  void test('conflictsChecked = false forces sequential', () => {
    const ctx = eligibleContext({ resources: { conflictsChecked: false } });
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['conflicting-resource-claims']);
  });

  void test('shared mutable state explicitly true', () => {
    const ctx = eligibleContext({ resources: { sharedMutableState: true } });
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['unsafe-shared-mutable-state']);
  });

  void test('missing validation readiness', () => {
    const ctx = eligibleContext({ readiness: { validationAvailable: false } });
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['validation-unavailable']);
  });

  void test('availableConcurrency below two', () => {
    const ctx = eligibleContext({ limits: { availableConcurrency: 1 } });
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['insufficient-available-concurrency']);
  });

  void test('a risk policy that requires serialisation', () => {
    const ctx = eligibleContext({ risk: { level: 'high', reasons: ['known unsafe pattern'] } });
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['risk-policy-requires-serialization']);
  });

  void test('an unknown risk policy is not evidence serialisation is unnecessary', () => {
    const ctx = eligibleContext({ risk: { level: 'unknown', reasons: [] } });
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.deepEqual(blockerCodes(result), ['risk-policy-requires-serialization']);
  });

  void test('every reason and blocker carries a code distinct from its message text', () => {
    const ctx = eligibleContext({ topology: { runnableTaskCount: 1 } });
    const result = evaluateExecutionStrategy(ctx);
    for (const entry of [...result.reasons, ...result.blockers]) {
      assert.equal(typeof entry.code, 'string');
      assert.ok(entry.code.length > 0);
      assert.notEqual(entry.code, entry.message);
    }
  });
});

void describe('evaluateExecutionStrategy — genuinely eligible input', () => {
  void test('two independent, ready tasks produce parallel', () => {
    const result = evaluateExecutionStrategy(eligibleContext());
    assert.equal(result.mode, 'parallel');
    assert.equal(result.eligible, true);
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(
      result.reasons.map((r) => r.code),
      ['all-conditions-satisfied'],
    );
  });

  void test('evaluatorVersion is a non-empty, stable string carried on every verdict', () => {
    const eligible = evaluateExecutionStrategy(eligibleContext());
    const blocked = evaluateExecutionStrategy({});
    assert.equal(eligible.evaluatorVersion, EVALUATOR_VERSION);
    assert.equal(blocked.evaluatorVersion, EVALUATOR_VERSION);
    assert.ok(EVALUATOR_VERSION.length > 0);
  });

  void test('effective concurrency is capped, never derived from available concurrency alone', () => {
    const ctx = eligibleContext({
      topology: { taskCount: 10, runnableTaskCount: 10 },
      limits: { requestedConcurrency: 10, availableConcurrency: 10 },
    });
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'parallel');
    assert.equal(result.requestedConcurrency, 10);
    // Default max concurrency (4) caps the result even though ten agents are "available".
    assert.equal(result.effectiveConcurrency, 4);
  });

  void test('an explicit maxConcurrency below 2 cannot produce mode "parallel" (mode and effectiveConcurrency must not disagree)', () => {
    // Was: mode "parallel" with effectiveConcurrency 1 — a consumer branching on `mode`
    // takes the parallel path, a consumer branching on `effectiveConcurrency` runs
    // sequentially. Two readings of one result (reviewer S4 / validator FINDING, generalised
    // to any input that floors the concurrency below 2, not only requestedConcurrency: 0).
    const ctx = eligibleContext({
      limits: { requestedConcurrency: 2, availableConcurrency: 2 },
    });
    const result = evaluateExecutionStrategy(ctx, { maxConcurrency: 1 });
    assert.equal(result.mode, 'sequential');
    assert.equal(result.eligible, false);
    assert.equal(result.effectiveConcurrency, 1);
    assert.deepEqual(blockerCodes(result), ['insufficient-effective-concurrency']);
  });

  void test('a non-integer maxConcurrency throws instead of reaching a verdict (tester F3: NaN sailed into mode "parallel" with effectiveConcurrency NaN)', () => {
    // Was: `Math.min(…, NaN)` is `NaN`, `NaN < 2` is `false`, so an eligible context with
    // `maxConcurrency: NaN` produced `mode: 'parallel', effectiveConcurrency: NaN` — and a
    // real Run then attested COMPLETED having executed zero tasks
    // (.artifacts/evidence/3/phase-gate/tester/README.md F3, run 203c2fa4). The options are
    // the caller's own config, so the failure mode is a throw, not a blocker code.
    const ctx = eligibleContext();
    for (const bad of [Number.NaN, 2.5, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => evaluateExecutionStrategy(ctx, { maxConcurrency: bad }),
        { name: 'TypeError', message: /maxConcurrency must be an integer/ },
        `maxConcurrency ${bad} must throw`,
      );
    }
  });

  void test('a negative integer maxConcurrency stays a sequential verdict, not a throw', () => {
    const result = evaluateExecutionStrategy(eligibleContext(), { maxConcurrency: -5 });
    assert.equal(result.mode, 'sequential');
    assert.equal(result.eligible, false);
    assert.equal(result.effectiveConcurrency, 1);
    assert.deepEqual(blockerCodes(result), ['insufficient-effective-concurrency']);
  });

  void test('requestedConcurrency: 0 on an otherwise-eligible context cannot produce mode "parallel"', () => {
    const ctx = eligibleContext({ limits: { requestedConcurrency: 0, availableConcurrency: 2 } });
    const result = evaluateExecutionStrategy(ctx);
    assert.equal(result.mode, 'sequential');
    assert.equal(result.eligible, false);
    assert.equal(result.effectiveConcurrency, 1);
    assert.deepEqual(blockerCodes(result), ['insufficient-effective-concurrency']);
  });

  void test('sequential verdicts always report effectiveConcurrency of 1', () => {
    const result = evaluateExecutionStrategy(
      eligibleContext({ topology: { runnableTaskCount: 1 } }),
    );
    assert.equal(result.mode, 'sequential');
    assert.equal(result.effectiveConcurrency, 1);
  });
});

void describe('evaluateExecutionStrategy — determinism', () => {
  void test('the same input twice produces an identical decision', () => {
    const inputA = structuredClone(eligibleContext({ topology: { runnableTaskCount: 1 } }));
    const inputB = structuredClone(eligibleContext({ topology: { runnableTaskCount: 1 } }));
    const resultA = evaluateExecutionStrategy(inputA);
    const resultB = evaluateExecutionStrategy(inputB);
    assert.deepEqual(resultA, resultB);
  });

  void test('multiple simultaneous failures report blockers in fixed rule order, not encounter order', () => {
    // Fails rule 1 (runnable tasks), rule 4 (conflicting resources) and rule 11 (available
    // concurrency), in that plan order — independent of the order the overrides are listed
    // below.
    const ctx = eligibleContext({
      limits: { availableConcurrency: 1 },
      resources: { conflictingResourceCount: 1 },
      topology: { runnableTaskCount: 1 },
    });
    const result = evaluateExecutionStrategy(ctx);
    assert.deepEqual(blockerCodes(result), [
      'insufficient-runnable-tasks',
      'conflicting-resource-claims',
      'insufficient-available-concurrency',
    ]);
  });

  void test('repeated calls with the fixed multi-failure input stay byte-identical', () => {
    const ctx = eligibleContext({
      limits: { availableConcurrency: 1 },
      resources: { conflictingResourceCount: 1 },
      topology: { runnableTaskCount: 1 },
    });
    const first = evaluateExecutionStrategy(structuredClone(ctx));
    const second = evaluateExecutionStrategy(structuredClone(ctx));
    assert.deepEqual(first, second);
  });
});
