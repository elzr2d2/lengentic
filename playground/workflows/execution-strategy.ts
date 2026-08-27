/**
 * The `execution_strategy` Decision — the wire shape for the Playground's Execute-phase
 * sequential-vs-parallel verdict (`MVP_PLAN_V3.md` §13 "Execution strategy is an ordinary
 * Decision", §14, §29; `CONTEXT.md` `execution_strategy` / `awarenessContext`).
 *
 * This module is a pure data transform, deliberately telemetry-free — the same split
 * `playground/strategy/evaluator.ts` already draws between "compute the verdict" and
 * "emit it": `evaluateExecutionStrategy` decides `mode`; this module turns that decision
 * plus the `AwarenessContext` it was computed from into exactly the fields a `Decision`
 * record carries (§13). *Emitting* that payload onto a `RunHandle`/`StepHandle` is the
 * orchestrator's job (`playground/agents/mock-agent.ts`), not this module's, because this
 * module has no telemetry client to emit through and no run/step tree to nest under.
 *
 * ## Why a Step, not a Decision, still carries this payload
 *
 * `MVP_PLAN_V3.md` §13's `Decision` entity — and the `decision.recordDecision` /
 * `decision.attestOutcome` calling convention §14 shows — has no wire event, schema, or
 * SDK surface yet: `platform/shared/schema/event-type.ts` enumerates exactly
 * `run.started`, `run.completed`, `step.started`, `step.completed`, and
 * `platform/telemetry-sdk/src/handles.ts` exposes exactly `RunHandle`/`StepHandle`. That
 * lands with `p4.sdk-decisions` (this packet's own note: "Needs p4.sdk-decisions to
 * persist end-to-end"). Until then, a `Step` is the closest existing telemetry primitive
 * an orchestrator can reach through `../index`, so the caller nests one `Step` named
 * `execution_strategy` and gives it this payload as `metadata` — the full Decision shape
 * riding on the one entity the wire actually has, not a second, narrower shape invented to
 * fit it. When `p4.sdk-decisions` lands, `buildExecutionStrategyDecision`'s return value is
 * what a real `decision.recordDecision({...})` call takes verbatim; only the emission call
 * changes, not this module.
 *
 * ## Boundedness (§15)
 *
 * `rawContext` here is the caller's own `AwarenessContext` (`playground/strategy/types.ts`)
 * plus `evaluation` — every field in both is a fixed-shape enum, `TriBool`, count, or a
 * `ReasonCode` (`{ code, message }`, both short and finite in number, never free text
 * appended without bound). Nothing here is a path, a hash, a timestamp, or a user-supplied
 * string, so the payload is bounded by construction; the SDK's own per-event cap
 * (`platform/shared/schema/limits.ts` `maxEventPayloadBytes`, enforced by
 * `platform/telemetry-sdk/src/events.ts` `checkEnvelope`) is the backstop, not the only
 * guard.
 */
import type { AwarenessContext, EvaluationResult, Mode, ReasonCode } from '../strategy';

/** §13: `decisionType execution_strategy`. */
export const EXECUTION_STRATEGY_DECISION_TYPE = 'execution_strategy';

/** §13: `availableOptions [sequential, parallel]` — `Mode`'s own two values, spelled out
 *  here rather than derived from the `Mode` union so the wire shape does not silently grow
 *  a third option the moment `Mode` does. */
export const EXECUTION_STRATEGY_AVAILABLE_OPTIONS = Object.freeze([
  'sequential',
  'parallel',
] as const satisfies readonly Mode[]);

/**
 * Versions this module's own `contextKey` derivation (§14 `contextKeyVersion`), not the
 * evaluator's rules (`EVALUATOR_VERSION`, carried separately inside `evaluation`) and not
 * `AwarenessContext.schemaVersion` (the input shape). A change to which dimensions this
 * module buckets on, or to a bucket's boundaries, bumps this — and, per §14, splits groups
 * instead of silently merging incompatible ones.
 */
export const EXECUTION_STRATEGY_CONTEXT_KEY_VERSION = 'execution-strategy-context-key@1';

/** §29's `awarenessContext` table names this sub-object `evaluation`
 *  (`eligible reasons[] blockers[] evaluatorVersion`) — the evaluator's *output*, folded
 *  back into the stored context alongside the *input* it was computed from. */
export interface ExecutionStrategyEvaluation {
  readonly eligible: boolean;
  readonly reasons: readonly ReasonCode[];
  readonly blockers: readonly ReasonCode[];
  readonly evaluatorVersion: string;
}

/** `CONTEXT.md:68-69` — "topology, resources, readiness, limits, risk, evaluation." The
 *  first five are `AwarenessContext` verbatim; `evaluation` is what this module adds. */
export interface ExecutionStrategyRawContext extends AwarenessContext {
  readonly evaluation: ExecutionStrategyEvaluation;
}

/** The `execution_strategy` Decision's wire fields (§13), independent of which telemetry
 *  primitive eventually carries them. */
export interface ExecutionStrategyDecisionPayload {
  readonly decisionType: typeof EXECUTION_STRATEGY_DECISION_TYPE;
  readonly availableOptions: typeof EXECUTION_STRATEGY_AVAILABLE_OPTIONS;
  readonly selectedOption: Mode;
  readonly contextKey: string;
  readonly contextKeyVersion: typeof EXECUTION_STRATEGY_CONTEXT_KEY_VERSION;
  readonly rawContext: ExecutionStrategyRawContext;
}

type RiskBucket = 'low' | 'medium' | 'high' | 'unknown';
type TaskCountBucket = '1' | '2-3' | '4-8' | '9+';
type DependencyBucket = 'none' | 'resolved' | 'unresolved';
type ResourceConflictBucket = 'present' | 'absent';
type ValidationReadinessBucket = 'ready' | 'not-ready';

/**
 * §14's own recommended derivation for `execution_strategy`: five coarse, enumerated
 * dimensions, none of them a count, id, path or timestamp — every dimension here has a
 * small fixed number of values, which is what lets `sampleCount` per bucket ever reach
 * G1 instead of every decision landing in its own group.
 *
 * `risk.level` is used as-is (`RiskLevel` already *is* this bucket's four values).
 * `risk.reasons[]` is deliberately never read here — free text is the forbidden dimension
 * §14 names explicitly.
 */
function riskBucket(context: AwarenessContext): RiskBucket {
  return context.risk.level;
}

/**
 * Bucketed on `topology.runnableTaskCount`, not `taskCount` — rule 1
 * (`playground/strategy/evaluator.ts`) is itself keyed on `runnableTaskCount`, so this is
 * the count that actually drives the verdict a caller would want grouped by. `0` and `1`
 * collapse into the same `'1'` bucket: both fail rule 1 identically ("at least two"), and
 * §14 asks for four coarse buckets, not five.
 */
function taskCountBucket(context: AwarenessContext): TaskCountBucket {
  const count = context.topology.runnableTaskCount;
  if (count <= 1) return '1';
  if (count <= 3) return '2-3';
  if (count <= 8) return '4-8';
  return '9+';
}

/**
 * `'none'` — no dependencies exist at all (`dependencyCount === 0`).
 * `'resolved'` — dependencies exist, are known, and none is unresolved.
 * `'unresolved'` — anything else, including `dependenciesKnown !== true`: an unverified
 * dependency graph is not evidence the dependencies happen to be resolved (`CONTEXT.md`
 * "Unknown is false"), so it buckets with the cases that are actually unresolved rather
 * than with `'resolved'`.
 */
function dependencyBucket(context: AwarenessContext): DependencyBucket {
  const { dependencyCount, unresolvedDependencyCount, dependenciesKnown } = context.topology;
  if (dependencyCount === 0) return 'none';
  if (dependenciesKnown === true && unresolvedDependencyCount === 0) return 'resolved';
  return 'unresolved';
}

/**
 * `'absent'` only when conflicts were actually checked and none were found. §14 gives this
 * dimension two values, not three, so an unchecked claim set (`conflictsChecked !==
 * true`) buckets as `'present'` rather than introducing a bucket §14 does not ask for —
 * the same "unknown is not the safe answer" reasoning `dependencyBucket` above uses.
 */
function resourceConflictBucket(context: AwarenessContext): ResourceConflictBucket {
  const { conflictingResourceCount, conflictsChecked } = context.resources;
  if (conflictsChecked === true && conflictingResourceCount === 0) return 'absent';
  return 'present';
}

/**
 * `'ready'` only when every `readiness` field is explicitly `true`. Any `false` or
 * `'unknown'` field buckets as `'not-ready'` — `readiness` is exactly the `TriBool` group
 * "Unknown is false" describes, and this dimension exists to summarize all five without
 * treating an unchecked one as a pass.
 */
function validationReadinessBucket(context: AwarenessContext): ValidationReadinessBucket {
  const {
    requirementsComplete,
    contractsStable,
    validationAvailable,
    independentlyValidatable,
    independentlyReversible,
  } = context.readiness;
  const ready =
    requirementsComplete === true &&
    contractsStable === true &&
    validationAvailable === true &&
    independentlyValidatable === true &&
    independentlyReversible === true;
  return ready ? 'ready' : 'not-ready';
}

/**
 * §14's five-dimension derivation, joined into one short stable string. `workflowName`,
 * `workflowVersion` and `contextKeyVersion` are already the group key elsewhere (§18) and
 * are deliberately not repeated here.
 */
export function computeExecutionStrategyContextKey(context: AwarenessContext): string {
  return [
    `risk:${riskBucket(context)}`,
    `tasks:${taskCountBucket(context)}`,
    `deps:${dependencyBucket(context)}`,
    `resources:${resourceConflictBucket(context)}`,
    `validation:${validationReadinessBucket(context)}`,
  ].join('|');
}

/** §29's `awarenessContext` table: the evaluator's input plus its output, folded into one
 *  object — this is the shape that rides as `rawContext` (§13). */
export function buildExecutionStrategyRawContext(
  context: AwarenessContext,
  result: EvaluationResult,
): ExecutionStrategyRawContext {
  return {
    ...context,
    evaluation: {
      eligible: result.eligible,
      reasons: result.reasons,
      blockers: result.blockers,
      evaluatorVersion: result.evaluatorVersion,
    },
  };
}

/**
 * The full `execution_strategy` Decision payload (§13) for one Execute-phase verdict.
 * Pure: same `context`/`result` in, same payload out — nothing here reads a clock, an id
 * generator, or a telemetry client. The caller emits this verbatim as the payload a
 * `Decision` (or, until `p4.sdk-decisions`, a `Step` standing in for one) carries.
 */
export function buildExecutionStrategyDecision(
  context: AwarenessContext,
  result: EvaluationResult,
): ExecutionStrategyDecisionPayload {
  return {
    decisionType: EXECUTION_STRATEGY_DECISION_TYPE,
    availableOptions: EXECUTION_STRATEGY_AVAILABLE_OPTIONS,
    selectedOption: result.mode,
    contextKey: computeExecutionStrategyContextKey(context),
    contextKeyVersion: EXECUTION_STRATEGY_CONTEXT_KEY_VERSION,
    rawContext: buildExecutionStrategyRawContext(context, result),
  };
}
