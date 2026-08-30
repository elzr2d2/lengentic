/**
 * Deterministic sequential-vs-parallel evaluator (`MVP_PLAN_V3.md` §29, Phase 3
 * "Execution-strategy evaluator").
 *
 * Pure function: same `AwarenessContext` in, same `EvaluationResult` out. No clock, no
 * randomness, no I/O, no network, no import of the telemetry SDK — the verdict must be
 * testable without telemetry (work packet `p3.strategy-evaluator`). Emitting the result as
 * an `execution_strategy` Decision is the orchestrator's job (§29 "the decision is emitted
 * as an ordinary Decision"), not this module's.
 *
 * "Unknown forces sequential" is the one safety property this file exists to make total, not
 * best-effort:
 *
 *   - Every `TriBool` field is explicitly `true`, `false`, or `'unknown'`. Only `true` (or,
 *     for `sharedMutableState`, only `false`) satisfies its rule below — `'unknown'` fails it
 *     exactly like an explicit failure would.
 *   - An `awarenessContext` that is missing, the wrong shape, or fails `schemaVersion: 1` is
 *     never partially evaluated. `parseAwarenessContext` returns `null` and
 *     `evaluateExecutionStrategy` short-circuits to `sequential` before any of the twelve
 *     rules run — there is no code path that reaches `mode: 'parallel'` without a fully
 *     validated context.
 *   - `risk.level` outside the known enum is treated as `'unknown'` by the type guard, not
 *     coerced to a passing value.
 *
 * Rule order below matches the numbered list in the plan section (1-12) exactly, so a
 * blocker's position in `blockers[]` can be looked up without re-deriving it, and so that
 * `blockers`/`reasons` order is itself deterministic for identical input.
 */

import type {
  AwarenessContext,
  EvaluateOptions,
  EvaluationResult,
  Limits,
  Mode,
  ReasonCode,
  Readiness,
  Resources,
  Risk,
  RiskLevel,
  Topology,
  TriBool,
} from './types';

/**
 * `evaluatorVersion` travels with every verdict (CONTEXT.md). It names the *ruleset*, not
 * this file's line count — bump it whenever a rule's condition changes, so a historical
 * comparison across the version boundary knows the rows are not comparable (§29 Stage 2).
 */
export const EVALUATOR_VERSION = 'strategy-evaluator@1.1.0';

/**
 * Small and configurable, per §29: "Maximum concurrency is small and configurable. It is
 * never derived from how many agents happen to be available." Overridable per call via
 * `EvaluateOptions.maxConcurrency`; the default never changes what `eligible` is, only how
 * much of an eligible batch actually runs at once.
 */
const DEFAULT_MAX_CONCURRENCY = 4;

const INVALID_CONTEXT: ReasonCode = {
  code: 'context-invalid',
  message:
    'awarenessContext is missing, malformed, or not schemaVersion 1 — treated as unknown, ' +
    'which forces sequential',
};

function isTriBool(value: unknown): value is TriBool {
  return value === true || value === false || value === 'unknown';
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRiskLevel(value: unknown): value is RiskLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'unknown';
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `Object.create(someValidShape)` produces an object whose fields all resolve through the
 * prototype chain — plain property access (`value.foo`) and destructuring both walk that
 * chain and cannot tell the difference, so a zero-own-property object would otherwise parse
 * as fully valid. Every parse function below checks this before reading a single field, so
 * an `awarenessContext` assembled by object composition (`Object.create`, a defaults-merge
 * helper) rather than `JSON.parse` gets the same total, all-or-nothing treatment as a
 * malformed shape.
 */
function hasOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function parseTopology(value: unknown): Topology | null {
  if (!isRecord(value)) return null;
  if (
    !hasOwnKeys(value, [
      'taskCount',
      'runnableTaskCount',
      'dependencyCount',
      'unresolvedDependencyCount',
      'dependenciesKnown',
    ])
  ) {
    return null;
  }
  const {
    taskCount,
    runnableTaskCount,
    dependencyCount,
    unresolvedDependencyCount,
    dependenciesKnown,
  } = value;
  if (
    !isNonNegativeInteger(taskCount) ||
    !isNonNegativeInteger(runnableTaskCount) ||
    !isNonNegativeInteger(dependencyCount) ||
    !isNonNegativeInteger(unresolvedDependencyCount) ||
    !isTriBool(dependenciesKnown) ||
    // Structurally impossible — more runnable tasks than the total task count — is treated
    // the same as a malformed shape, not as a rule failure: a topology that claims this is
    // not "a graph with a blocker in it", it is a graph whose own numbers cannot be trusted
    // (the same reasoning `unresolvedDependencyCount <= dependencyCount` already applies at
    // rule level; this one is checked earlier because nothing downstream can use taskCount
    // meaningfully once it is violated).
    runnableTaskCount > taskCount
  ) {
    return null;
  }
  return {
    taskCount,
    runnableTaskCount,
    dependencyCount,
    unresolvedDependencyCount,
    dependenciesKnown,
  };
}

function parseResources(value: unknown): Resources | null {
  if (!isRecord(value)) return null;
  if (
    !hasOwnKeys(value, [
      'claimedResourceCount',
      'conflictingResourceCount',
      'conflictsChecked',
      'sharedMutableState',
    ])
  ) {
    return null;
  }
  const { claimedResourceCount, conflictingResourceCount, conflictsChecked, sharedMutableState } =
    value;
  if (
    !isNonNegativeInteger(claimedResourceCount) ||
    !isNonNegativeInteger(conflictingResourceCount) ||
    !isTriBool(conflictsChecked) ||
    !isTriBool(sharedMutableState)
  ) {
    return null;
  }
  return { claimedResourceCount, conflictingResourceCount, conflictsChecked, sharedMutableState };
}

function parseReadiness(value: unknown): Readiness | null {
  if (!isRecord(value)) return null;
  if (
    !hasOwnKeys(value, [
      'requirementsComplete',
      'contractsStable',
      'validationAvailable',
      'independentlyValidatable',
      'independentlyReversible',
    ])
  ) {
    return null;
  }
  const {
    requirementsComplete,
    contractsStable,
    validationAvailable,
    independentlyValidatable,
    independentlyReversible,
  } = value;
  if (
    !isTriBool(requirementsComplete) ||
    !isTriBool(contractsStable) ||
    !isTriBool(validationAvailable) ||
    !isTriBool(independentlyValidatable) ||
    !isTriBool(independentlyReversible)
  ) {
    return null;
  }
  return {
    requirementsComplete,
    contractsStable,
    validationAvailable,
    independentlyValidatable,
    independentlyReversible,
  };
}

function parseLimits(value: unknown): Limits | null {
  if (!isRecord(value)) return null;
  if (!hasOwnKeys(value, ['requestedConcurrency', 'availableConcurrency'])) return null;
  const { requestedConcurrency, availableConcurrency } = value;
  if (!isNonNegativeInteger(requestedConcurrency) || !isNonNegativeInteger(availableConcurrency)) {
    return null;
  }
  return { requestedConcurrency, availableConcurrency };
}

function parseRisk(value: unknown): Risk | null {
  if (!isRecord(value)) return null;
  if (!hasOwnKeys(value, ['level'])) return null;
  const { level, reasons } = value;
  if (!isRiskLevel(level)) return null;
  return { level, reasons: isStringArray(reasons) ? reasons : [] };
}

/**
 * Total: never throws. Anything that does not fully match schemaVersion 1 is `null`, which
 * `evaluateExecutionStrategy` treats as the whole context being unknown.
 */
function parseAwarenessContext(input: unknown): AwarenessContext | null {
  if (!isRecord(input)) return null;
  if (
    !hasOwnKeys(input, ['schemaVersion', 'topology', 'resources', 'readiness', 'limits', 'risk'])
  ) {
    return null;
  }
  if (input.schemaVersion !== 1) return null;

  const topology = parseTopology(input.topology);
  const resources = parseResources(input.resources);
  const readiness = parseReadiness(input.readiness);
  const limits = parseLimits(input.limits);
  const risk = parseRisk(input.risk);

  if (
    topology === null ||
    resources === null ||
    readiness === null ||
    limits === null ||
    risk === null
  ) {
    return null;
  }

  return { schemaVersion: 1, topology, resources, readiness, limits, risk };
}

function describeTriBool(value: TriBool): string {
  if (value === 'unknown') return 'unknown';
  return value ? 'true' : 'false';
}

interface RuleCheck {
  readonly code: string;
  readonly passed: boolean;
  readonly message: string;
}

/**
 * The twelve conditions from §29, in the plan's own numbered order. Every one must pass for
 * `eligible: true` — a single failure is enough to force `sequential`.
 */
function runRules(context: AwarenessContext): RuleCheck[] {
  const { topology, resources, readiness, limits, risk } = context;

  return [
    {
      code: 'insufficient-runnable-tasks',
      passed: topology.runnableTaskCount >= 2,
      message: `at least two meaningful runnable tasks are required; runnableTaskCount is ${topology.runnableTaskCount}`,
    },
    {
      // "Task dependencies are known" (condition 2). Two independent ways to fail it: nobody
      // affirmatively verified the graph (`dependenciesKnown` is not `true` — CONTEXT.md
      // "Unknown is false"), or the counts describing it are internally inconsistent (more
      // unresolved dependencies than known dependencies). Either failure means the graph
      // cannot be trusted, which is a distinct, earlier concern than condition 3's "is it
      // fully resolved" — an inconsistent-count input fails both, but a
      // `dependenciesKnown !== true` input can fail this condition alone even when the
      // counts themselves look clean (e.g. all zeros), which is exactly the shape that
      // silently passed before `dependenciesKnown` existed.
      code: 'dependencies-not-known',
      passed:
        topology.dependenciesKnown === true &&
        topology.unresolvedDependencyCount <= topology.dependencyCount,
      message:
        topology.dependenciesKnown !== true
          ? `dependenciesKnown is ${describeTriBool(topology.dependenciesKnown)}, not affirmatively true — the dependency graph was never verified`
          : `unresolvedDependencyCount (${topology.unresolvedDependencyCount}) exceeds ` +
            `dependencyCount (${topology.dependencyCount}); the dependency graph is not reliably known`,
    },
    {
      code: 'unresolved-dependencies',
      passed: topology.unresolvedDependencyCount === 0,
      message: `${topology.unresolvedDependencyCount} unresolved dependency(ies) between candidate tasks`,
    },
    {
      // "Resource claims do not conflict" (condition 4). Same shape as condition 2 above:
      // `conflictingResourceCount: 0` must not read as "verified, no conflicts" when it is
      // actually "nobody checked" — `conflictsChecked` carries that knowledge explicitly.
      code: 'conflicting-resource-claims',
      passed: resources.conflictsChecked === true && resources.conflictingResourceCount === 0,
      message:
        resources.conflictsChecked !== true
          ? `conflictsChecked is ${describeTriBool(resources.conflictsChecked)}, not affirmatively true — resource conflicts were never verified`
          : `${resources.conflictingResourceCount} conflicting resource claim(s)`,
    },
    {
      code: 'unsafe-shared-mutable-state',
      passed: resources.sharedMutableState === false,
      message: `sharedMutableState is ${describeTriBool(resources.sharedMutableState)}, not affirmatively false`,
    },
    {
      code: 'requirements-incomplete',
      passed: readiness.requirementsComplete === true,
      message: `requirementsComplete is ${describeTriBool(readiness.requirementsComplete)}, not affirmatively true`,
    },
    {
      code: 'contracts-unstable',
      passed: readiness.contractsStable === true,
      message: `contractsStable is ${describeTriBool(readiness.contractsStable)}, not affirmatively true`,
    },
    {
      code: 'validation-unavailable',
      passed: readiness.validationAvailable === true,
      message: `validationAvailable is ${describeTriBool(readiness.validationAvailable)}, not affirmatively true`,
    },
    {
      code: 'not-independently-validatable',
      passed: readiness.independentlyValidatable === true,
      message: `independentlyValidatable is ${describeTriBool(readiness.independentlyValidatable)}, not affirmatively true`,
    },
    {
      code: 'not-independently-reversible',
      passed: readiness.independentlyReversible === true,
      message: `independentlyReversible is ${describeTriBool(readiness.independentlyReversible)}, not affirmatively true`,
    },
    {
      code: 'insufficient-available-concurrency',
      passed: limits.availableConcurrency >= 2,
      message: `availableConcurrency must be at least 2; it is ${limits.availableConcurrency}`,
    },
    {
      // 'high' is a risk policy that requires serialisation by definition. 'unknown' is
      // treated the same way: an unverifiable risk policy is not evidence that serialisation
      // is unnecessary (CONTEXT.md "Unknown is false").
      code: 'risk-policy-requires-serialization',
      passed: risk.level === 'low' || risk.level === 'medium',
      message: `risk level is "${risk.level}", which requires serialisation`,
    },
  ];
}

function toReasonCode(check: RuleCheck): ReasonCode {
  return { code: check.code, message: check.message };
}

/**
 * `evaluateExecutionStrategy` accepts `unknown` deliberately (TS-1: unknown at an external
 * boundary, narrowed before use) — the caller assembles `awarenessContext` from live
 * orchestrator state, and this function is the boundary that must never trust its shape.
 */
export function evaluateExecutionStrategy(
  input: unknown,
  options: EvaluateOptions = {},
): EvaluationResult {
  // `options` is the caller's own configuration, not the untrusted `awarenessContext`, so a
  // bad value is a programming error and throws instead of mapping to a blocker code. The
  // check matters because every arithmetic guard below survives a non-integer silently:
  // `Math.min(…, NaN)` is `NaN`, `NaN < 2` is `false`, so `NaN` sails past
  // `insufficient-effective-concurrency` straight into `mode: 'parallel'` with
  // `effectiveConcurrency: NaN` — parallel that was never earned (§29). Negative integers
  // stay accepted: they clamp to a floor of 1 and force sequential, which is well-defined.
  if (options.maxConcurrency !== undefined && !Number.isInteger(options.maxConcurrency)) {
    throw new TypeError(
      `evaluateExecutionStrategy: maxConcurrency must be an integer, got ${String(options.maxConcurrency)}`,
    );
  }
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const context = parseAwarenessContext(input);

  if (context === null) {
    return {
      mode: 'sequential',
      eligible: false,
      reasons: [INVALID_CONTEXT],
      blockers: [INVALID_CONTEXT],
      requestedConcurrency: 0,
      effectiveConcurrency: 1,
      evaluatorVersion: EVALUATOR_VERSION,
    };
  }

  const checks = runRules(context);
  const ruleBlockers = checks.filter((check) => !check.passed).map(toReasonCode);

  // Computed unconditionally, before eligibility is decided, so `mode` and
  // `effectiveConcurrency` can never disagree: `mode: 'parallel'` with
  // `effectiveConcurrency: 1` would tell a consumer branching on `mode` and a consumer
  // branching on `effectiveConcurrency` two different stories about the same verdict
  // (`requestedConcurrency: 0` on an otherwise-eligible context was the reproduction —
  // §29 "Sequential default — parallel is an exception that must be earned", and a batch of
  // one is not an earned exception).
  const concurrencyFloor = Math.max(
    1,
    Math.min(
      context.limits.requestedConcurrency,
      context.limits.availableConcurrency,
      context.topology.runnableTaskCount,
      maxConcurrency,
    ),
  );

  const insufficientConcurrency: ReasonCode | null =
    ruleBlockers.length === 0 && concurrencyFloor < 2
      ? {
          code: 'insufficient-effective-concurrency',
          message:
            `the concurrency this context would actually get is ${concurrencyFloor} ` +
            `(min of requestedConcurrency ${context.limits.requestedConcurrency}, ` +
            `availableConcurrency ${context.limits.availableConcurrency}, ` +
            `runnableTaskCount ${context.topology.runnableTaskCount}, and maxConcurrency ` +
            `${maxConcurrency}), which cannot justify mode "parallel"`,
        }
      : null;

  const blockers =
    insufficientConcurrency === null ? ruleBlockers : [...ruleBlockers, insufficientConcurrency];
  const eligible = blockers.length === 0;
  const mode: Mode = eligible ? 'parallel' : 'sequential';

  const allSatisfied: ReasonCode = {
    code: 'all-conditions-satisfied',
    message: 'all twelve parallel-eligibility conditions were explicitly satisfied',
  };
  const reasons = eligible ? [allSatisfied] : blockers;

  const effectiveConcurrency = eligible ? concurrencyFloor : 1;

  return {
    mode,
    eligible,
    reasons,
    blockers,
    requestedConcurrency: context.limits.requestedConcurrency,
    effectiveConcurrency,
    evaluatorVersion: EVALUATOR_VERSION,
  };
}
