/**
 * `MockAgentConfig` and `MockAgentTaskConfig` live here rather than in `mock-agent.ts`
 * itself, for exactly one reason: `./scenario-seed.ts` needs `MockAgentConfig`'s shape to
 * type `deriveScenarioSeed`'s parameter, and `mock-agent.ts` needs `deriveScenarioSeed`
 * itself — a straight two-file split would make `mock-agent.ts -> scenario-seed.ts ->
 * mock-agent.ts` a cycle, which `pnpm check:boundaries`'s `no-circular` rule forbids
 * regardless of the import being type-only. Putting the *input* shape in a third module that
 * imports from neither breaks the cycle without a deep import either way. `MockAgent`'s own
 * runtime class, `MockAgentConfigError`, and its two result types (`MockAgentRunResult`,
 * `MockAgentTaskResult`) stay in `mock-agent.ts`, which re-exports these two for
 * `playground/agents/index.ts`'s existing `from './mock-agent'` import to keep working.
 */
import type { SeededClockOptions } from '../determinism';
import type { StartRunInput, TelemetryConfig } from '../index';
import type { MockProviderConfig } from '../providers';
import type { AwarenessContext } from '../strategy';

/** Mirrors `mock-agent.ts`'s own `Metadata` derivation exactly. Re-derived here, rather than
 *  imported from `mock-agent.ts`, so this module has no edge back into it (see the module
 *  doc above) — `StartRunInput` is the SDK's own wire-contract-derived type, so the two
 *  derivations cannot drift apart from each other even though they are two expressions. */
type Metadata = NonNullable<StartRunInput['metadata']>;

/** One unit of Execute-phase work. `MockAgent` calls `MockProvider.invoke({ step: name })`
 *  for each, so `name` doubles as the provider's own per-call identity — kept distinct
 *  across a single run (validated in `mock-agent.ts`'s constructor) for the same reason
 *  `MockProviderRequest.callIndex` exists: two tasks colliding on derived randomness would
 *  silently stop being "two tasks". */
export interface MockAgentTaskConfig {
  readonly name: string;
}

/**
 * `MockProviderConfig` minus `seed` (this config's own `seed` feeds both seed domains —
 * see `mock-agent.ts`'s module doc) — reusing its field types instead of re-declaring them
 * keeps `MockAgentConfig`'s provider knobs from silently drifting out of sync with what
 * `MockProvider` actually validates.
 */
export interface MockAgentConfig extends Pick<
  MockProviderConfig,
  'contextSeed' | 'delayMs' | 'failureRate' | 'alwaysFailSteps' | 'scheduler'
> {
  readonly seed: number;
  /** Execute-phase work items. Default: a single task — the deliberate "sequential
   *  default" shape (§29): with fewer than two runnable tasks, rule 1 alone forces
   *  `sequential` regardless of every other field. */
  readonly tasks?: readonly MockAgentTaskConfig[];
  /** `AwarenessContext.limits.availableConcurrency` when `awarenessContext` is not
   *  overridden. Default 4, matching the evaluator's own default `maxConcurrency`
   *  (`playground/strategy/evaluator.ts`). */
  readonly availableConcurrency?: number;
  /** Passed straight through to `evaluateExecutionStrategy` as `EvaluateOptions`. */
  readonly maxConcurrency?: number;
  /**
   * Escape hatch for a caller that wants to exercise a specific evaluator rule (an
   * unresolved dependency, a conflicting resource claim, an `unknown` readiness field,
   * …) directly, instead of the default context this class derives from `tasks.length`
   * and `availableConcurrency`. `playground/strategy` already owns the twelve-rule test
   * matrix (`p3.strategy-evaluator`); this knob exists so a caller of `MockAgent` is not
   * limited to what the derived default can express, not to re-prove those rules here.
   */
  readonly awarenessContext?: AwarenessContext;
  readonly workflowName?: string;
  readonly workflowVersion?: string;
  readonly metadata?: Metadata;
  /** Passed through to `createSeededPlaygroundTelemetry`. `clock`/`idGenerator` set here
   *  are overridden by the seeded pair regardless (`determinism/telemetry.ts`'s own
   *  guarantee) — `transport` is the field a test actually uses. */
  readonly telemetryConfig?: TelemetryConfig;
  readonly clockOptions?: SeededClockOptions;
}
