/**
 * Types for the execution-strategy evaluator (`MVP_PLAN_V3.md` §29, Phase 3 "Execution-strategy
 * evaluator").
 *
 * `AwarenessContext` is the evaluator's *input* — the facts the orchestrator has gathered
 * about a candidate batch of tasks before it decides whether they may run in parallel. It is
 * deliberately narrower than the `awarenessContext` that eventually rides on the
 * `execution_strategy` Decision's `rawContext` (CONTEXT.md): that stored shape also carries
 * the evaluation result. Combining the two is the orchestrator's job when it emits telemetry;
 * this package only computes the result.
 *
 * Every field that has no reliable source is `TriBool`, never a plain `boolean`. A rule that
 * cannot be checked is not the same fact as a rule that was checked and failed, and collapsing
 * that distinction is exactly how "unknown" stops forcing the safe fallback.
 */

/**
 * `true | false | unknown` — CONTEXT.md "Unknown is false": a required condition nobody
 * verified did not pass, so it is carried as its own state rather than defaulted to `false`
 * and silently losing the "nobody checked" information.
 */
export type TriBool = true | false | 'unknown';

export interface Topology {
  readonly taskCount: number;
  readonly runnableTaskCount: number;
  readonly dependencyCount: number;
  readonly unresolvedDependencyCount: number;
}

export interface Resources {
  readonly claimedResourceCount: number;
  readonly conflictingResourceCount: number;
  readonly sharedMutableState: TriBool;
}

export interface Readiness {
  readonly requirementsComplete: TriBool;
  readonly contractsStable: TriBool;
  readonly validationAvailable: TriBool;
  readonly independentlyValidatable: TriBool;
  readonly independentlyReversible: TriBool;
}

export interface Limits {
  readonly requestedConcurrency: number;
  readonly availableConcurrency: number;
}

/**
 * `'low' | 'medium'` never force serialisation on their own. `'high'` is a risk policy that
 * requires it (rule 12). `'unknown'` is treated the same as `'high'` — an unverifiable risk
 * policy is not evidence that serialisation is unnecessary. This three/four-way split is an
 * implementation decision this package owns (§29 states the condition, not the scale); it is
 * recorded here rather than left implicit so a reviewer can find and, if needed, revisit it.
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';

export interface Risk {
  readonly level: RiskLevel;
  readonly reasons: readonly string[];
}

/** Schema-versioned input. `schemaVersion` travels with the shape, not with `evaluatorVersion`
 * (which versions the *rules*, not the *input shape* — CONTEXT.md `evaluatorVersion`). */
export interface AwarenessContext {
  readonly schemaVersion: 1;
  readonly topology: Topology;
  readonly resources: Resources;
  readonly readiness: Readiness;
  readonly limits: Limits;
  readonly risk: Risk;
}

export type Mode = 'sequential' | 'parallel';

/** A stable machine-readable code plus a human-readable description. Tests and callers must
 * branch on `code`, never on `message` — the packet's own acceptance criterion. */
export interface ReasonCode {
  readonly code: string;
  readonly message: string;
}

export interface EvaluationResult {
  readonly mode: Mode;
  readonly eligible: boolean;
  readonly reasons: readonly ReasonCode[];
  readonly blockers: readonly ReasonCode[];
  readonly requestedConcurrency: number;
  readonly effectiveConcurrency: number;
  readonly evaluatorVersion: string;
}

export interface EvaluateOptions {
  /**
   * Hard ceiling on `effectiveConcurrency`. Capacity is not permission (§29): this is never
   * derived from `availableConcurrency`, only clamped by it.
   */
  readonly maxConcurrency?: number;
}
