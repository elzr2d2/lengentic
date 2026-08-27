/**
 * Tests for `playground/workflows` (`./execution-strategy.ts`), the `execution_strategy`
 * Decision payload builder — §13, §14, §29; `CONTEXT.md` `execution_strategy` /
 * `awarenessContext`.
 *
 * Seam under test: the module's public functions (`buildExecutionStrategyDecision`,
 * `buildExecutionStrategyRawContext`, `computeExecutionStrategyContextKey`), called exactly
 * as `playground/agents/mock-agent.ts` calls them — never the private bucket helpers, which
 * are not exported.
 *
 * Negative fixtures first (`CLAUDE.md` "write the negative fixtures before the positive
 * path"): §14 forbids a `contextKey` derived from anything unbounded, so the negative claim
 * this module must prove is "distinct coarse situations stay distinct, and free text/counts
 * never leak into the key" — before any test asserts what one specific key string looks
 * like.
 *
 * Runner: Node's built-in `node:test`/`node:assert/strict`, same convention every other
 * `playground/**` package uses (`playground/package.json`'s `test` script globs
 * `**\/*.spec.ts`).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildExecutionStrategyDecision,
  buildExecutionStrategyRawContext,
  computeExecutionStrategyContextKey,
  EXECUTION_STRATEGY_AVAILABLE_OPTIONS,
  EXECUTION_STRATEGY_CONTEXT_KEY_VERSION,
  EXECUTION_STRATEGY_DECISION_TYPE,
} from '../index';
import { EVALUATOR_VERSION, evaluateExecutionStrategy } from '../../strategy';
import type {
  AwarenessContext,
  EvaluationResult,
  Readiness,
  Resources,
  Risk,
} from '../../strategy';

/** Mirrors `playground/strategy/evaluator.test.ts`'s own `eligibleContext` helper: every
 *  condition holds so a single override isolates exactly one dimension.
 *  `structuredClone` guards against a test mutating a shared literal. */
function context(
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
    limits: { requestedConcurrency: 2, availableConcurrency: 2 },
    risk: { level: 'low', reasons: [] },
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

/** A real evaluator run, not a hand-built `EvaluationResult` — sourcing `evaluation` from
 *  `playground/strategy`'s own output (which owns that matrix) rather than fabricating one
 *  keeps this suite from asserting against its own guess of the evaluator's shape. */
function evaluate(ctx: AwarenessContext): EvaluationResult {
  return evaluateExecutionStrategy(ctx);
}

void describe('computeExecutionStrategyContextKey — NEGATIVE: distinct situations must stay distinct, forbidden dimensions must not leak in', () => {
  void it('two different risk levels produce two different keys', () => {
    const low = computeExecutionStrategyContextKey(context({ risk: { level: 'low' } }));
    const high = computeExecutionStrategyContextKey(context({ risk: { level: 'high' } }));
    assert.notEqual(low, high);
  });

  void it('changing risk.reasons (free text) alone does not change the key — §14 forbids free text as a dimension', () => {
    const withoutReasons = computeExecutionStrategyContextKey(
      context({ risk: { level: 'medium', reasons: [] } }),
    );
    const withReasons = computeExecutionStrategyContextKey(
      context({ risk: { level: 'medium', reasons: ['a very specific narrative'] } }),
    );
    assert.equal(withoutReasons, withReasons);
  });

  void it('runnableTaskCount 1 and 9 (opposite ends of the range) produce two different keys', () => {
    const one = computeExecutionStrategyContextKey(context({ topology: { runnableTaskCount: 1 } }));
    const nine = computeExecutionStrategyContextKey(
      context({ topology: { runnableTaskCount: 9 } }),
    );
    assert.notEqual(one, nine);
  });

  void it('the exact numeric runnableTaskCount never appears verbatim in the key — only the bucket does', () => {
    const key = computeExecutionStrategyContextKey(context({ topology: { runnableTaskCount: 7 } }));
    assert.equal(key.includes('tasks:7'), false);
    assert.ok(key.includes('tasks:4-8'));
  });

  void it('"no dependencies" and "unresolved dependencies" produce two different keys', () => {
    const none = computeExecutionStrategyContextKey(
      context({ topology: { dependencyCount: 0, unresolvedDependencyCount: 0 } }),
    );
    const unresolved = computeExecutionStrategyContextKey(
      context({
        topology: { dependencyCount: 1, unresolvedDependencyCount: 1, dependenciesKnown: true },
      }),
    );
    assert.notEqual(none, unresolved);
  });

  void it('resource conflict present and absent produce two different keys', () => {
    const absent = computeExecutionStrategyContextKey(
      context({ resources: { conflictingResourceCount: 0, conflictsChecked: true } }),
    );
    const present = computeExecutionStrategyContextKey(
      context({ resources: { conflictingResourceCount: 1, conflictsChecked: true } }),
    );
    assert.notEqual(absent, present);
  });

  void it('validation ready and not-ready produce two different keys', () => {
    const ready = computeExecutionStrategyContextKey(context());
    const notReady = computeExecutionStrategyContextKey(
      context({ readiness: { validationAvailable: false } }),
    );
    assert.notEqual(ready, notReady);
  });
});

void describe('computeExecutionStrategyContextKey — "Unknown is false" applies to bucketing too', () => {
  void it('dependenciesKnown "unknown" buckets as unresolved even when unresolvedDependencyCount is 0', () => {
    const key = computeExecutionStrategyContextKey(
      context({
        topology: {
          dependencyCount: 2,
          unresolvedDependencyCount: 0,
          dependenciesKnown: 'unknown',
        },
      }),
    );
    assert.ok(key.includes('deps:unresolved'));
  });

  void it('conflictsChecked "unknown" buckets as present even when conflictingResourceCount is 0', () => {
    const key = computeExecutionStrategyContextKey(
      context({ resources: { conflictingResourceCount: 0, conflictsChecked: 'unknown' } }),
    );
    assert.ok(key.includes('resources:present'));
  });

  void it('a single "unknown" readiness field forces not-ready, same as an explicit false', () => {
    const unknownField = computeExecutionStrategyContextKey(
      context({ readiness: { independentlyReversible: 'unknown' } }),
    );
    const falseField = computeExecutionStrategyContextKey(
      context({ readiness: { independentlyReversible: false } }),
    );
    assert.ok(unknownField.includes('validation:not-ready'));
    assert.equal(unknownField, falseField);
  });
});

void describe('computeExecutionStrategyContextKey — POSITIVE: exact bucket boundaries', () => {
  const cases: Array<[number, string]> = [
    [0, 'tasks:1'],
    [1, 'tasks:1'],
    [2, 'tasks:2-3'],
    [3, 'tasks:2-3'],
    [4, 'tasks:4-8'],
    [8, 'tasks:4-8'],
    [9, 'tasks:9+'],
    [100, 'tasks:9+'],
  ];
  for (const [runnableTaskCount, expected] of cases) {
    void it(`runnableTaskCount ${runnableTaskCount} buckets as ${expected}`, () => {
      const key = computeExecutionStrategyContextKey(context({ topology: { runnableTaskCount } }));
      assert.ok(key.includes(expected));
    });
  }

  void it('the fully-eligible fixture produces the exact expected key, all five dimensions in order', () => {
    const key = computeExecutionStrategyContextKey(context());
    assert.equal(key, 'risk:low|tasks:2-3|deps:none|resources:absent|validation:ready');
  });
});

void describe('buildExecutionStrategyRawContext', () => {
  void it('carries topology, resources, readiness, limits and risk from the input context unchanged', () => {
    const ctx = context({ risk: { level: 'high' } });
    const result = evaluate(ctx);
    const rawContext = buildExecutionStrategyRawContext(ctx, result);
    assert.deepEqual(rawContext.topology, ctx.topology);
    assert.deepEqual(rawContext.resources, ctx.resources);
    assert.deepEqual(rawContext.readiness, ctx.readiness);
    assert.deepEqual(rawContext.limits, ctx.limits);
    assert.deepEqual(rawContext.risk, ctx.risk);
  });

  void it('adds an evaluation field with eligible, reasons, blockers and evaluatorVersion — CONTEXT.md:68-69', () => {
    const ctx = context({ topology: { runnableTaskCount: 1 } }); // ineligible by rule 1
    const result = evaluate(ctx);
    const rawContext = buildExecutionStrategyRawContext(ctx, result);
    assert.equal(rawContext.evaluation.eligible, result.eligible);
    assert.equal(rawContext.evaluation.eligible, false);
    assert.deepEqual(rawContext.evaluation.reasons, result.reasons);
    assert.deepEqual(rawContext.evaluation.blockers, result.blockers);
    assert.equal(rawContext.evaluation.evaluatorVersion, result.evaluatorVersion);
    assert.equal(rawContext.evaluation.evaluatorVersion, EVALUATOR_VERSION);
  });
});

void describe('buildExecutionStrategyDecision — the full §13 Decision payload', () => {
  void it('sets decisionType, availableOptions and contextKeyVersion to the fixed §13 constants', () => {
    const ctx = context();
    const decision = buildExecutionStrategyDecision(ctx, evaluate(ctx));
    assert.equal(decision.decisionType, 'execution_strategy');
    assert.equal(decision.decisionType, EXECUTION_STRATEGY_DECISION_TYPE);
    assert.deepEqual(decision.availableOptions, ['sequential', 'parallel']);
    assert.deepEqual(decision.availableOptions, EXECUTION_STRATEGY_AVAILABLE_OPTIONS);
    assert.equal(decision.contextKeyVersion, EXECUTION_STRATEGY_CONTEXT_KEY_VERSION);
  });

  void it('selectedOption is exactly the evaluator verdict’s mode, for both sequential and parallel', () => {
    const sequentialCtx = context({ topology: { runnableTaskCount: 1 } });
    const sequentialResult = evaluate(sequentialCtx);
    assert.equal(sequentialResult.mode, 'sequential');
    assert.equal(
      buildExecutionStrategyDecision(sequentialCtx, sequentialResult).selectedOption,
      'sequential',
    );

    const parallelCtx = context();
    const parallelResult = evaluate(parallelCtx);
    assert.equal(parallelResult.mode, 'parallel');
    assert.equal(
      buildExecutionStrategyDecision(parallelCtx, parallelResult).selectedOption,
      'parallel',
    );
  });

  void it('contextKey matches computeExecutionStrategyContextKey(context) exactly', () => {
    const ctx = context({ risk: { level: 'medium' } });
    const decision = buildExecutionStrategyDecision(ctx, evaluate(ctx));
    assert.equal(decision.contextKey, computeExecutionStrategyContextKey(ctx));
  });

  void it('rawContext matches buildExecutionStrategyRawContext(context, result) exactly', () => {
    const ctx = context();
    const result = evaluate(ctx);
    const decision = buildExecutionStrategyDecision(ctx, result);
    assert.deepEqual(decision.rawContext, buildExecutionStrategyRawContext(ctx, result));
  });

  void it('is a pure function: same context and result in, byte-identical (deepEqual) payload out', () => {
    const ctx = context({ topology: { runnableTaskCount: 5 } });
    const result = evaluate(ctx);
    const first = buildExecutionStrategyDecision(ctx, result);
    const second = buildExecutionStrategyDecision(ctx, result);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });
});
