/**
 * MockAgent — the Playground's reference orchestrator (`MVP_PLAN_V3.md` "Initial Mock
 * Agent", Phase 3 work package 3): `Start → Plan → Execute → Validate → Complete`, no
 * Planner/Researcher/Coder/Reviewer split yet. This is the "Mock Agent" half of
 * `Mock Agent → Telemetry SDK → LenGentic` — the independent consumer that proves a host
 * can be instrumented through the SDK's public entry alone.
 *
 * It composes four things earlier Phase 3 packets already shipped, each through its own
 * package entry (never a deep import):
 *   - `../providers` (`p3.mock-provider`)  — deterministic, offline step output.
 *   - `../determinism` (`p3.seeded-clock`) — a seeded `Clock`/`IdGenerator` pair wired into
 *     a real `TelemetryClient`.
 *   - `../strategy` (`p3.strategy-evaluator`) — the sequential-vs-parallel verdict for the
 *     Execute phase's tasks.
 *   - `../workflows` (`p3.strategy-telemetry`) — turns that verdict into the
 *     `execution_strategy` Decision payload (§13) this class emits.
 * `../index` (the Playground's composition root) is the one place any of that reaches
 * `@lengentic/telemetry-sdk` — this module never imports the SDK directly.
 *
 * ## Two seed domains, one scenario seed
 *
 * `MockProvider` (its own `seed`/`contextSeed`) and `createSeededComponents` (the
 * telemetry `Clock`/`IdGenerator`) are independent seed domains — nothing before this
 * packet wired them together (`.artifacts/backlog/pending.md`, trigger `p3.mock-agent`).
 * `MockAgent` closes that gap by construction rather than by convention: `MockAgentConfig`
 * exposes exactly one `seed`, and both domains are constructed from that single number
 * (`this.seed` below), never from two independently-supplied seeds. This is deliberately
 * the simplest composition — identity, not a second derivation — because the two domains
 * already use unrelated PRNG streams: `SeededClock`/`SeededIdGenerator` fold `seed`
 * through their own internal state, and `MockProvider` folds it again per call through
 * `seed ^ hashToSeed(step|callIndex|salt)`. Reusing the same numeric value across both
 * therefore creates no shared state and no cross-domain correlation — it only pins both
 * deterministically from one scenario input, which is what "same seed → byte-identical
 * telemetry" (this packet's own acceptance criterion) requires. `contextSeed` stays a
 * separate, optional knob (defaulting to `seed` inside `MockProvider` itself) for the
 * Phase 6 "same outcome, different context" replay the plan's Mock Provider section calls
 * out.
 */
import { createSeededPlaygroundTelemetry, type SeededClockOptions } from '../determinism';
import type { StartRunInput, TelemetryClient, TelemetryConfig } from '../index';
import {
  MockProvider,
  MockProviderFailure,
  type MockProviderConfig,
  type MockProviderRequest,
} from '../providers';
import {
  evaluateExecutionStrategy,
  type AwarenessContext,
  type EvaluationResult,
} from '../strategy';
import { buildExecutionStrategyDecision } from '../workflows';

/**
 * These four shapes are the SDK's own `RunHandle`/`StepHandle`/`StartStepInput`/
 * `CompleteInput` (`platform/telemetry-sdk/src/handles.ts`), but `../index` — the one seam
 * `playground-sdk-public-entry-only` lets this package name the SDK through — does not
 * re-export them (it re-exports `StartRunInput`, `TelemetryClient`, `TelemetryConfig` and
 * the determinism/scheduler surface, not the handle types). Widening `../index` is outside
 * `playground/agents/**`'s `allowed_paths`, and a deep import into
 * `@lengentic/telemetry-sdk/src/handles` would trip the same boundary rule from the other
 * side. Deriving the shapes structurally from `TelemetryClient` — which *is* re-exported —
 * composes without either: same types, no new name needed from the composition root.
 */
type RunHandle = ReturnType<TelemetryClient['startRun']>;
type StepHandle = ReturnType<RunHandle['startStep']>;
type StepCompleteInput = NonNullable<Parameters<StepHandle['complete']>[0]>;
type TerminalStatus = NonNullable<StepCompleteInput['status']>;
type Metadata = NonNullable<StartRunInput['metadata']>;
type TelemetryStats = ReturnType<TelemetryClient['stats']>;

/** Either a `Run` (top-level steps) or a `Step` (nested steps) — both expose the same
 *  `startStep`/`complete` shape, so a helper that only needs to start one more nested step
 *  or terminate its own does not need to distinguish which kind of parent it was handed. */
type StepParent = Pick<RunHandle, 'startStep'>;

const AGENT_NAME = 'mock-agent';
const DEFAULT_WORKFLOW_NAME = 'mock-agent-workflow';
const DEFAULT_WORKFLOW_VERSION = '1.0.0';
const DEFAULT_AVAILABLE_CONCURRENCY = 4;
const DEFAULT_TASKS: readonly MockAgentTaskConfig[] = Object.freeze([{ name: 'default' }]);

export class MockAgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MockAgentConfigError';
  }
}

/** One unit of Execute-phase work. `MockAgent` calls `MockProvider.invoke({ step: name })`
 *  for each, so `name` doubles as the provider's own per-call identity — kept distinct
 *  across a single run (validated in the constructor) for the same reason
 *  `MockProviderRequest.callIndex` exists: two tasks colliding on derived randomness would
 *  silently stop being "two tasks". */
export interface MockAgentTaskConfig {
  readonly name: string;
}

export interface MockAgentTaskResult {
  readonly name: string;
  readonly status: TerminalStatus;
  readonly detail?: string;
  readonly error?: string;
}

export interface MockAgentRunResult {
  readonly runId: string;
  readonly status: TerminalStatus;
  /** The Execute-phase verdict this run actually followed (§29). Present even when Plan
   *  failed before Execute ever started — the verdict is a pure function of
   *  `awarenessContext`, independent of whether execution went ahead. */
  readonly strategy: EvaluationResult;
  readonly tasks: readonly MockAgentTaskResult[];
  readonly telemetryStats: TelemetryStats;
}

/**
 * `MockProviderConfig` minus `seed` (this config's own `seed` feeds both seed domains —
 * see the module doc above) — reusing its field types instead of re-declaring them keeps
 * `MockAgentConfig`'s provider knobs from silently drifting out of sync with what
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

function validateTasks(tasks: readonly MockAgentTaskConfig[]): void {
  if (tasks.length === 0) {
    throw new MockAgentConfigError('MockAgent: tasks must contain at least one task');
  }
  const seen = new Set<string>();
  for (const task of tasks) {
    if (task.name.length === 0) {
      throw new MockAgentConfigError('MockAgent: task name must be a non-empty string');
    }
    if (seen.has(task.name)) {
      throw new MockAgentConfigError(`MockAgent: duplicate task name "${task.name}"`);
    }
    seen.add(task.name);
  }
}

function validateAvailableConcurrency(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new MockAgentConfigError(
      `MockAgent: availableConcurrency must be a non-negative integer, got ${value}`,
    );
  }
}

/**
 * The context this class hands `evaluateExecutionStrategy` when the caller does not
 * override it. Deliberately "obviously eligible modulo task count and concurrency": every
 * `TriBool` readiness/topology/resource field is affirmatively satisfied and
 * `sharedMutableState` is affirmatively `false`, because `MockAgent`'s own tasks are
 * independent `MockProvider.invoke()` calls with no shared state or real dependency graph
 * between them. That leaves `runnableTaskCount` (from `tasks.length`) and
 * `availableConcurrency` as the only two inputs that actually vary the verdict here — which
 * is exactly what makes "one task → sequential, two independent tasks → parallel"
 * observable without hand-building a full `AwarenessContext` for the common case.
 */
function buildDefaultAwarenessContext(
  taskCount: number,
  availableConcurrency: number,
): AwarenessContext {
  return {
    schemaVersion: 1,
    topology: {
      taskCount,
      runnableTaskCount: taskCount,
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
      requestedConcurrency: taskCount,
      availableConcurrency,
    },
    risk: {
      level: 'low',
      reasons: [],
    },
  };
}

function buildProviderConfig(config: MockAgentConfig): MockProviderConfig {
  // exactOptionalPropertyTypes (TS-8): `MockProviderConfig`'s optional fields are typed
  // `X?`, not `X | undefined`, so assigning an explicit `undefined` (which
  // `config.contextSeed` etc. may well be) is a type error even though the key is
  // optional. Each field is therefore included only when actually present, the same
  // pattern `handles.ts`'s own `metadataOf` uses for the same reason.
  return {
    seed: config.seed,
    ...(config.contextSeed !== undefined ? { contextSeed: config.contextSeed } : {}),
    ...(config.delayMs !== undefined ? { delayMs: config.delayMs } : {}),
    ...(config.failureRate !== undefined ? { failureRate: config.failureRate } : {}),
    ...(config.alwaysFailSteps !== undefined ? { alwaysFailSteps: config.alwaysFailSteps } : {}),
    ...(config.scheduler !== undefined ? { scheduler: config.scheduler } : {}),
  };
}

/** Runs `items` through `worker`, at most `limit` in flight at once. `limit === 1`
 *  degenerates to strictly sequential (start, complete, start, complete, …); `limit >=
 *  items.length` starts every item before any of them can complete. This is the one
 *  execution primitive both Execute-phase modes below share — `sequential` is `parallel`
 *  with `effectiveConcurrency` clamped to 1, not a second code path that could drift from
 *  the first. */
async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;

  async function runNext(): Promise<void> {
    for (;;) {
      const index = cursor;
      if (index >= items.length) return;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
  return results;
}

interface ProviderStepOutcome {
  readonly ok: boolean;
  readonly detail?: string;
  readonly error?: string;
}

export class MockAgent {
  private readonly seed: number;

  private readonly tasks: readonly MockAgentTaskConfig[];

  private readonly availableConcurrency: number;

  private readonly maxConcurrency: number | undefined;

  private readonly awarenessContextOverride: AwarenessContext | undefined;

  private readonly workflowName: string;

  private readonly workflowVersion: string;

  private readonly metadata: Metadata | undefined;

  private readonly telemetryConfig: TelemetryConfig;

  private readonly clockOptions: SeededClockOptions | undefined;

  /**
   * Built here, not in `run()`: `MockProvider`'s own constructor is where `seed`/
   * `contextSeed` range validation (R4) actually lives, and constructing it eagerly means
   * an invalid `MockAgentConfig` throws synchronously from `new MockAgent(...)` — the same
   * fail-fast moment `MockAgentConfigError` already fires at for `tasks` and
   * `availableConcurrency` below — instead of only surfacing as a rejected `run()` promise.
   * `MockProvider` itself holds no run-scoped state (`invoke()`'s determinism is keyed on
   * the request, never on an internal call counter), so reusing one instance across `run()`
   * — not that `MockAgent` currently allows more than one — would be safe regardless.
   */
  private readonly provider: MockProvider;

  constructor(config: MockAgentConfig) {
    const tasks = config.tasks ?? DEFAULT_TASKS;
    validateTasks(tasks);
    const availableConcurrency = config.availableConcurrency ?? DEFAULT_AVAILABLE_CONCURRENCY;
    validateAvailableConcurrency(availableConcurrency);

    this.seed = config.seed;
    this.tasks = tasks;
    this.availableConcurrency = availableConcurrency;
    this.maxConcurrency = config.maxConcurrency;
    this.awarenessContextOverride = config.awarenessContext;
    this.workflowName = config.workflowName ?? DEFAULT_WORKFLOW_NAME;
    this.workflowVersion = config.workflowVersion ?? DEFAULT_WORKFLOW_VERSION;
    this.metadata = config.metadata;
    this.telemetryConfig = config.telemetryConfig ?? {};
    this.clockOptions = config.clockOptions;
    this.provider = new MockProvider(buildProviderConfig(config));
  }

  /**
   * Drives one complete `Start → Plan → Execute → Validate → Complete` run and returns
   * once its telemetry has been flushed and the client shut down — a `MockAgent` is a
   * single run, not a reusable session, so a caller (the CLI, a test) never has to manage
   * the telemetry client's lifecycle itself. A Plan (or Validate) failure short-circuits
   * the remaining phases: `run.complete({ status: 'FAILED' })` still fires, but Execute
   * never starts on a Plan that failed, and Validate never starts on an Execute that did.
   */
  async run(): Promise<MockAgentRunResult> {
    const telemetry = createSeededPlaygroundTelemetry(
      this.seed,
      this.telemetryConfig,
      this.clockOptions,
    );
    const provider = this.provider;
    const run = telemetry.startRun({
      workflowName: this.workflowName,
      workflowVersion: this.workflowVersion,
      metadata: this.metadata,
    });

    const strategy = evaluateExecutionStrategy(
      this.awarenessContextOverride ??
        buildDefaultAwarenessContext(this.tasks.length, this.availableConcurrency),
      this.maxConcurrency !== undefined ? { maxConcurrency: this.maxConcurrency } : {},
    );

    let status: TerminalStatus = 'COMPLETED';
    const taskResults: MockAgentTaskResult[] = [];

    const plan = await this.runPhaseStep(run, provider, 'plan');
    if (!plan.ok) status = 'FAILED';

    if (status === 'COMPLETED') {
      const executeOutcome = await this.runExecute(run, provider, strategy);
      taskResults.push(...executeOutcome.tasks);
      if (!executeOutcome.ok) status = 'FAILED';
    }

    if (status === 'COMPLETED') {
      const validate = await this.runPhaseStep(run, provider, 'validate');
      if (!validate.ok) status = 'FAILED';
    }

    run.complete({ status });
    await telemetry.flush();
    const telemetryStats = telemetry.stats();
    await telemetry.shutdown();

    return { runId: run.runId, status, strategy, tasks: taskResults, telemetryStats };
  }

  /** Plan and Validate are both "one `MockProvider` call, one top-level Step" — the only
   *  difference between them is the step name, so they share this one implementation. */
  private async runPhaseStep(
    run: RunHandle,
    provider: MockProvider,
    phase: 'plan' | 'validate',
  ): Promise<ProviderStepOutcome> {
    const step = run.startStep({ name: phase, agentName: AGENT_NAME, type: phase });
    return this.invokeAndComplete(provider, step, { step: phase });
  }

  private async runExecute(
    run: RunHandle,
    provider: MockProvider,
    strategy: EvaluationResult,
  ): Promise<{ ok: boolean; tasks: MockAgentTaskResult[] }> {
    const executeStep = run.startStep({
      name: 'execute',
      agentName: AGENT_NAME,
      type: 'execute',
    });
    this.recordStrategyDecision(executeStep, strategy);

    const results = await runWithConcurrency(this.tasks, strategy.effectiveConcurrency, (task) =>
      this.runTask(executeStep, provider, task),
    );

    const ok = results.every((result) => result.status === 'COMPLETED');
    executeStep.complete({ status: ok ? 'COMPLETED' : 'FAILED' });
    return { ok, tasks: results };
  }

  /**
   * Emits the Execute phase's sequential-vs-parallel verdict "as ordinary telemetry" (§29:
   * "the decision is emitted as an ordinary Decision", not a second pipeline) — a nested
   * Step, started and completed immediately, whose `metadata` carries the full
   * `execution_strategy` Decision payload (`../workflows`'s `buildExecutionStrategyDecision`):
   * `decisionType`, `availableOptions`, `selectedOption`, `contextKey`, `contextKeyVersion`,
   * and `rawContext` (§29's `awarenessContext` — topology, resources, readiness, limits,
   * risk, `evaluation`). One verdict, emitted once.
   *
   * This is still not a proper `execution_strategy` `Decision` *entity* — that wire event
   * (`p4.sdk-decisions`, §13) does not exist yet: `platform/shared/schema/event-type.ts`
   * enumerates exactly `run.*`/`step.*`, and `platform/telemetry-sdk/src/handles.ts` exposes
   * exactly `RunHandle`/`StepHandle`. A Step is the closest existing telemetry primitive this
   * run can actually reach through `../index`, so it carries the Decision-shaped payload
   * `../workflows` builds — not a narrower, Step-specific shape invented to fit the
   * primitive. When `p4.sdk-decisions` lands, `buildExecutionStrategyDecision`'s return value
   * is what a real Decision emission takes verbatim; only this method's call changes.
   */
  private recordStrategyDecision(executeStep: StepHandle, strategy: EvaluationResult): void {
    const context =
      this.awarenessContextOverride ??
      buildDefaultAwarenessContext(this.tasks.length, this.availableConcurrency);
    const decision = buildExecutionStrategyDecision(context, strategy);
    const decisionStep = executeStep.startStep({
      name: 'execution_strategy',
      agentName: AGENT_NAME,
      type: 'decision',
      metadata: { ...decision },
    });
    decisionStep.complete();
  }

  private async runTask(
    executeStep: StepParent,
    provider: MockProvider,
    task: MockAgentTaskConfig,
  ): Promise<MockAgentTaskResult> {
    const step = executeStep.startStep({ name: task.name, agentName: AGENT_NAME, type: 'task' });
    const outcome = await this.invokeAndComplete(provider, step, { step: task.name });
    return {
      name: task.name,
      status: outcome.ok ? 'COMPLETED' : 'FAILED',
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
  }

  /** One `MockProvider.invoke()` call, completing `step` with the outcome — success or a
   *  `MockProviderFailure` (the simulated-failure shape every non-`MockProviderFailure`
   *  rejection is not: a config error there is this class's own bug, not a scenario
   *  outcome, and is left to propagate rather than being reported as a step failure). */
  private async invokeAndComplete(
    provider: MockProvider,
    step: StepHandle,
    request: MockProviderRequest,
  ): Promise<ProviderStepOutcome> {
    try {
      const response = await provider.invoke(request);
      step.complete({
        status: 'COMPLETED',
        metadata: { detail: response.detail, contextVariation: response.contextVariation },
      });
      return { ok: true, detail: response.detail };
    } catch (error) {
      if (!(error instanceof MockProviderFailure)) throw error;
      step.complete({ status: 'FAILED', metadata: { error: error.message } });
      return { ok: false, error: error.message };
    }
  }
}
