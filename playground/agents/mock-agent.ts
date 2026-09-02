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
 * ## Two seed domains, one scenario input
 *
 * `MockProvider` (its own `seed`/`contextSeed`) and `createSeededComponents` (the
 * telemetry `Clock`/`IdGenerator`) are independent seed domains — nothing before this
 * packet wired them together (`.artifacts/backlog/pending.md`, trigger `p3.mock-agent`).
 * `MockAgentConfig` exposes exactly one `seed`, but the two domains no longer receive it
 * *identically* — that identity composition was F1
 * (`.artifacts/evidence/3/phase-gate/tester/README.md`): because the telemetry domain's
 * runId is a pure function of `seed` alone, two scenarios that only differed in
 * `workflowName`, `contextSeed`, or any other field minted the same runId, and the second
 * one's telemetry was silently discarded as a duplicate by the `(runId, eventId)` ledger
 * key.
 *
 * The **provider** domain still takes the raw `seed` unchanged (`buildProviderConfig`
 * below, `this.provider` in the constructor) — a scenario's simulated *outcome* stays a
 * pure function of `seed` alone, which is what `MVP_PLAN_V3.md:1641` means by "vary in
 * context but not in outcome": replaying the same `seed` under a different `contextSeed`
 * must still resolve/fail exactly the same way, only the recorded `contextVariation`
 * differs.
 *
 * The **telemetry** domain takes `deriveScenarioSeed(config)`
 * (`./scenario-seed.ts`) instead: run identity is a function of the *whole* scenario, not
 * of `seed` in isolation. `deriveScenarioSeed` folds every `MockAgentConfig` field except
 * `seed`, `scheduler` and `telemetryConfig` into the seed it hands
 * `createSeededPlaygroundTelemetry`, so two scenarios that differ in any way that would
 * actually change what gets recorded also differ in which runId they mint. "Same seed →
 * byte-identical telemetry" (this packet's own acceptance criterion) still holds exactly:
 * the derivation is a pure function of the declared config, so two `MockAgent`s built from
 * the *same* config (same `seed`, same everything else that matters) always derive the
 * same telemetry seed and therefore emit byte-identical envelopes.
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
import { deriveScenarioSeed, ScenarioSeedError } from './scenario-seed';
import type { MockAgentConfig, MockAgentTaskConfig } from './types';

/** Re-exported so `playground/agents/index.ts`'s existing `from './mock-agent'` import
 *  keeps working — the types themselves now live in `./types.ts` (see that module's doc for
 *  why: breaking an import cycle with `./scenario-seed.ts`). */
export type { MockAgentConfig, MockAgentTaskConfig };

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

/** Same fail-fast moment as `availableConcurrency`: `evaluateExecutionStrategy` throws on a
 *  non-integer `maxConcurrency` too, but only mid-`run()`, after `startRun` has already
 *  emitted telemetry — the constructor is where a config mistake must surface. */
function validateMaxConcurrency(value: number | undefined): void {
  if (value !== undefined && !Number.isInteger(value)) {
    throw new MockAgentConfigError(`MockAgent: maxConcurrency must be an integer, got ${value}`);
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
  /** The scenario-derived seed — the telemetry domain's (see the module doc above). The
   *  raw `seed` is not otherwise retained: `MockProvider` (the provider domain) is built
   *  eagerly below from `config.seed` directly and holds its own copy. */
  private readonly telemetrySeed: number;

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
    validateMaxConcurrency(config.maxConcurrency);

    this.tasks = tasks;
    this.availableConcurrency = availableConcurrency;
    this.maxConcurrency = config.maxConcurrency;
    this.awarenessContextOverride = config.awarenessContext;
    this.workflowName = config.workflowName ?? DEFAULT_WORKFLOW_NAME;
    this.workflowVersion = config.workflowVersion ?? DEFAULT_WORKFLOW_VERSION;
    this.metadata = config.metadata;
    this.telemetryConfig = config.telemetryConfig ?? {};
    this.clockOptions = config.clockOptions;
    // Built before `deriveScenarioSeed` below: this is where `seed`'s own 32-bit-integer
    // range validation lives (R4), and AC-9 requires the out-of-range error to stay exactly
    // `MockProvider`'s message — `deriveScenarioSeed` deliberately performs no range check
    // of its own (see its module doc), so it must never run first.
    this.provider = new MockProvider(buildProviderConfig(config));
    try {
      this.telemetrySeed = deriveScenarioSeed(config);
    } catch (error) {
      // A silent fallback to the raw `seed` here would reinstate F1 for exactly the config
      // that cannot be hashed (e.g. circular `metadata`) — fail the same way every other
      // config mistake in this constructor already does.
      if (error instanceof ScenarioSeedError) throw new MockAgentConfigError(error.message);
      throw error;
    }
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
      this.telemetrySeed,
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

  /**
   * One `MockProvider.invoke()` call, completing `step` with the outcome — success or a
   * `MockProviderFailure` (the simulated-failure shape every non-`MockProviderFailure`
   * rejection is not: a config error there is this class's own bug, not a scenario
   * outcome, and is left to propagate rather than being reported as a step failure).
   *
   * This is the one place the Playground calls a provider, so it is the one place
   * `model_call.recorded` is emitted — every phase step (Plan, each Execute task, Validate)
   * funnels through here, and so does every simulated failure. Both events carry the
   * measurements `MockProvider` reports for the call that actually ran
   * (`MockProviderCallStats`), never a constant restated at this layer: the DoD preamble
   * asks a Run to show "which models ... were called, where failures occurred"
   * (`MVP_PLAN_V3.md:1802`), and a hardcoded latency would answer it falsely.
   *
   * Determinism (§17) survives because none of it reads a clock: `latencyMs` is the seeded
   * delay `MockProvider` derived from the request, and the token counts are functions of the
   * request and generated text. Same seed → same events, byte for byte.
   */
  private async invokeAndComplete(
    provider: MockProvider,
    step: StepHandle,
    request: MockProviderRequest,
  ): Promise<ProviderStepOutcome> {
    try {
      const response = await provider.invoke(request);
      step.recordModelCall({
        provider: response.provider,
        model: response.model,
        latencyMs: response.latencyMs,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        status: 'success',
      });
      step.complete({
        status: 'COMPLETED',
        metadata: { detail: response.detail, contextVariation: response.contextVariation },
      });
      return { ok: true, detail: response.detail };
    } catch (error) {
      if (!(error instanceof MockProviderFailure)) throw error;
      // The call still happened, so it is still a ModelCall — with the status that says how
      // it ended. `outputTokens` is omitted rather than sent as 0: a failed call produced no
      // output, which is not the same statement as producing an empty one.
      step.recordModelCall({
        provider: error.stats.provider,
        model: error.stats.model,
        latencyMs: error.stats.latencyMs,
        inputTokens: error.stats.inputTokens,
        status: 'failure',
      });
      step.recordError({
        type: error.name,
        message: error.message,
        metadata: { step: error.step, callIndex: error.callIndex },
      });
      step.complete({ status: 'FAILED', metadata: { error: error.message } });
      return { ok: false, error: error.message };
    }
  }
}
