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
export const EVALUATOR_VERSION = 'strategy-evaluator@1.0.0';

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

function parseTopology(value: unknown): Topology | null {
  if (!isRecord(value)) return null;
  const { taskCount, runnableTaskCount, dependencyCount, unresolvedDependencyCount } = value;
  if (
    !isNonNegativeInteger(taskCount) ||
    !isNonNegativeInteger(runnableTaskCount) ||
    !isNonNegativeInteger(dependencyCount) ||
    !isNonNegativeInteger(unresolvedDependencyCount)
  ) {
    return null;
  }
  return { taskCount, runnableTaskCount, dependencyCount, unresolvedDependencyCount };
}

function parseResources(value: unknown): Resources | null {
  if (!isRecord(value)) return null;
  const { claimedResourceCount, conflictingResourceCount, sharedMutableState } = value;
  if (
    !isNonNegativeInteger(claimedResourceCount) ||
    !isNonNegativeInteger(conflictingResourceCount) ||
    !isTriBool(sharedMutableState)
  ) {
    return null;
  }
  return { claimedResourceCount, conflictingResourceCount, sharedMutableState };
}

function parseReadiness(value: unknown): Readiness | null {
  if (!isRecord(value)) return null;
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
  const { requestedConcurrency, availableConcurrency } = value;
  if (!isNonNegativeInteger(requestedConcurrency) || !isNonNegativeInteger(availableConcurrency)) {
    return null;
  }
  return { requestedConcurrency, availableConcurrency };
}

function parseRisk(value: unknown): Risk | null {
  if (!isRecord(value)) return null;
  const { level, reasons } = value;
  if (!isRiskLevel(level)) return null;
  return { level, reasons: isStringArray(reasons) ? reasons : [] };
}

/**
 * Total: never throws. Anything that does not fully match schemaVersion 1 is `null`, which
 * `evaluateExecutionStrategy` treats as the whole context being unknown.
 */
function parseAwarenessContext(input: unknown): AwarenessContext | null {
  if (!isRecord(input) || input.schemaVersion !== 1) return null;

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
      // "Task dependencies are known" (condition 2): the counts describing the dependency
      // graph must be internally consistent. More unresolved dependencies than known
      // dependencies is not a smaller version of condition 3's failure — it means the graph
      // itself cannot be trusted, which is a distinct, earlier failure.
      code: 'dependencies-not-known',
      passed: topology.unresolvedDependencyCount <= topology.dependencyCount,
      message:
        `unresolvedDependencyCount (${topology.unresolvedDependencyCount}) exceeds ` +
        `dependencyCount (${topology.dependencyCount}); the dependency graph is not reliably known`,
    },
    {
      code: 'unresolved-dependencies',
      passed: topology.unresolvedDependencyCount === 0,
      message: `${topology.unresolvedDependencyCount} unresolved dependency(ies) between candidate tasks`,
    },
    {
      code: 'conflicting-resource-claims',
      passed: resources.conflictingResourceCount === 0,
      message: `${resources.conflictingResourceCount} conflicting resource claim(s)`,
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
  const blockers = checks.filter((check) => !check.passed).map(toReasonCode);
  const eligible = blockers.length === 0;
  const mode: Mode = eligible ? 'parallel' : 'sequential';

  const allSatisfied: ReasonCode = {
    code: 'all-conditions-satisfied',
    message: 'all twelve parallel-eligibility conditions were explicitly satisfied',
  };
  const reasons = eligible ? [allSatisfied] : blockers;

  const effectiveConcurrency = eligible
    ? Math.max(
        1,
        Math.min(
          context.limits.requestedConcurrency,
          context.limits.availableConcurrency,
          context.topology.runnableTaskCount,
          maxConcurrency,
        ),
      )
    : 1;

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
