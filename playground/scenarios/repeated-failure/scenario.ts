/**
 * Scenario 2 — Repeated Failed Action (`MVP_PLAN_V3.md` Phase 6, work package 1).
 *
 * ```text
 * Generate → Test → FAIL
 * Modify   → Test → FAIL
 * Modify   → Test → FAIL
 *
 * Expected: REPEATED_FAILED_ACTION
 * ```
 *
 * The controlled Product Agent behaviour §20.2's analyzer is defined against: one run, one
 * tool, one input, three consecutive failures, no success between them. Every §20.2
 * condition is satisfied *by construction* here — the same frozen `TOOL_INPUT` object and
 * the same `TOOL_NAME` on all three attempts, inside one `startRun`, with nothing between
 * them that succeeds.
 *
 * ## What this file does NOT do
 *
 * It never decides whether §20.2 would emit. `playground-not-to-analysis-engine`
 * (`pnpm check:boundaries`) exists precisely because "a Playground that could import the
 * analyzer could shape its telemetry to satisfy it", and a hand-rolled verdict here would be
 * a second definition of the analyzer, free to disagree with the one the product ships. What
 * this scenario reports is what it *emitted* — one runId, one toolName, one
 * `inputFingerprint`, three failed attempts — and the caller reads that emission, never a
 * verdict.
 *
 * `REPEATED_FAILED_ACTION` IS reachable through the API since `p6.s2-platform-path`:
 * `tool_call.recorded` carries the SDK's sanitized `inputFingerprint`, and `POST
 * /v1/analysis/run` evaluates §20.2 over the persisted tool calls (live-endpoint coverage in
 * `platform/api/test/repeated-failed-action.integration.spec.ts`). Proving the analyzer fires on
 * this run's data THROUGH THE SDK is still `p7.e2e`'s assertion, not this command's.
 *
 * ## Same target, same command
 *
 * "Same target and same test command across repetitions — otherwise the input-similarity
 * condition correctly rejects it" (Phase 6, Scenario 2). `TOOL_INPUT` is therefore a single
 * frozen constant recorded three times rather than three separately built objects that
 * happen to look alike today: two literals can drift apart under an edit, one constant
 * cannot. `inputFingerprint` is computed per attempt from the value that attempt actually
 * recorded, so the fingerprint this scenario reports is evidence about what was sent rather
 * than a constant restated.
 *
 * ## `fingerprintOf` comes from the SDK, not from here
 *
 * §20.2's `inputFingerprint` is computed by the SDK itself since `p6.s2-platform-path`
 * and rides `tool_call.recorded` (`platform/shared/schema/tool-call-events.ts`). This scenario
 * still computes it here, with the SDK's own `fingerprintOf`, to REPORT what it emitted — the
 * two are the same function over the same sanitized input, and the spec pins that they agree.
 * The hash is over the *sanitized* input, which is why the SDK exports `fingerprintOf` "so a
 * caller can compute that hash with the same sanitizer the SDK uses" (`payload-safety.ts`). This is the
 * one import in `playground/**` that names `@lengentic/telemetry-sdk` outside `../../index`:
 * the composition root does not re-export `fingerprintOf`, and widening it is outside this
 * packet's `allowed_paths`, so the alternatives were a second FNV-1a implementation inside
 * the Playground (a second opinion on a contract the SDK owns — `playground/index.ts`'s own
 * module doc) or no fingerprint at all. The import names the SDK's public entry, which is
 * exactly what `playground-sdk-public-entry-only` allows.
 *
 * ## One clock, not two
 *
 * `RecordToolCallInput.startedAt`/`completedAt` are caller-supplied client-clock values
 * (§13), so this scenario has to *read* the same seeded clock the telemetry client stamps
 * its envelopes with. `createSeededPlaygroundTelemetry` builds that pair internally and
 * cannot hand it back, so the components are built here through the same one construction
 * site (`createSeededComponents`, `../../determinism`) and composed with
 * `createPlaygroundTelemetry` (`../../index`) — the two lines that factory would have run.
 * A second `SeededClock` would put two independent time sequences in one run's timeline:
 * tool calls timestamped before the steps that made them.
 *
 * Determinism (§17) holds the ordinary way: same seed → same ids, same timestamps, same
 * `MockProvider` output, byte-identical envelopes.
 */
import { fingerprintOf } from '@lengentic/telemetry-sdk';

import { createSeededComponents, namespacedSeed, type SeededClockOptions } from '../../determinism';
import {
  createPlaygroundTelemetry,
  type Clock,
  type TelemetryClient,
  type TelemetryConfig,
} from '../../index';
import { MockProvider, type MockProviderResponse } from '../../providers';

type RunHandle = ReturnType<TelemetryClient['startRun']>;
type StepHandle = ReturnType<RunHandle['startStep']>;
type TelemetryStats = ReturnType<TelemetryClient['stats']>;

const WORKFLOW_NAME = 'repeated-failure-workflow';
const WORKFLOW_VERSION = '1.0.0';
const AGENT_NAME = 'repeated-failure-agent';

/** Folded into the id/clock seed so this scenario's keys are disjoint from the others'. */
const SCENARIO_NAMESPACE = 'repeated-failure';

/** §20.2's floor is three consecutive failed attempts, and the scenario emits exactly that —
 *  a fourth attempt would prove nothing the third does not. */
export const ATTEMPTS = 3;

export const TOOL_NAME = 'run_tests';

/** The one input every attempt records. Frozen so a mutation between attempts cannot
 *  silently split one streak into three fingerprints (see the module doc). */
export const TOOL_INPUT = Object.freeze({
  command: 'pnpm test',
  target: 'checkout.spec.ts',
  watch: false,
});

/** The failing run's output, identical on every attempt: the same test fails the same way,
 *  which is what "repeated failed action" means. */
const TOOL_OUTPUT = Object.freeze({
  exitCode: 1,
  failed: 1,
  passed: 7,
  firstFailure: 'checkout > applies the discount before tax',
});

export const FAILURE_MESSAGE =
  'AssertionError: expected checkout total 42 to equal 40 — checkout.spec.ts:31';

/** The Error entity each failed attempt records beside its ToolCall. §20.2 counts an attempt
 *  as failed when `outcome === 'FAILED'` OR an Error was recorded; this run satisfies both
 *  halves, which is also what "where failures occurred" (§23) asks a Run to show. */
const ERROR_TYPE = 'TestSuiteFailure';

export interface RepeatedFailureScenarioOptions {
  readonly seed: number;
  /** Passed through to the telemetry client — endpoint, transport, `maxRetries`, … */
  readonly telemetryConfig?: TelemetryConfig;
  readonly clockOptions?: SeededClockOptions;
}

/** One `run_tests` attempt, as it was recorded. `inputFingerprint` is §20.2's caller-owned
 *  grouping key, computed over the value this attempt actually passed to the SDK. */
export interface RepeatedFailureAttempt {
  /** 1-based, in emission order. */
  readonly attempt: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly inputFingerprint: string;
  readonly success: boolean;
  readonly error: string;
}

export interface RepeatedFailureScenarioResult {
  readonly runId: string;
  /** Always `FAILED`: the simulated agent never fixed the test. The *scenario* succeeding
   *  and the *run* failing are different statements — `main.ts` maps only the first one to
   *  an exit code. */
  readonly status: 'FAILED';
  readonly attempts: readonly RepeatedFailureAttempt[];
  readonly telemetryStats: TelemetryStats;
}

/**
 * Drives the scenario once and returns after its telemetry has been flushed and the client
 * shut down — a single run, like `MockAgent`, not a reusable session.
 *
 * `MockProvider` supplies the Generate and Modify steps' model calls with the failure knobs
 * left at their defaults (`failureRate: 0`, no `alwaysFailSteps`): the failures in this
 * scenario are the *tool's*, scripted below, not the provider's. A `MockProviderFailure`
 * from a provider configured never to fail would be this module's own bug, so it is left to
 * propagate rather than being reported as a step outcome.
 */
export async function runRepeatedFailureScenario(
  options: RepeatedFailureScenarioOptions,
): Promise<RepeatedFailureScenarioResult> {
  // Ids and clock are namespaced by scenario: the same `--seed` must not mint the same
  // (runId, eventId) keys as another scenario's CLI (wave-gate F1). The provider keeps the
  // raw seed — its output is not part of the ledger key.
  const { clock, idGenerator } = createSeededComponents(
    namespacedSeed(SCENARIO_NAMESPACE, options.seed),
    options.clockOptions,
  );
  const telemetry = createPlaygroundTelemetry({
    ...(options.telemetryConfig ?? {}),
    clock,
    idGenerator,
  });
  const provider = new MockProvider({ seed: options.seed, delayMs: 0, failureRate: 0 });

  const run = telemetry.startRun({
    workflowName: WORKFLOW_NAME,
    workflowVersion: WORKFLOW_VERSION,
    metadata: { scenario: 'repeated-failed-action', seed: options.seed },
  });

  const attempts: RepeatedFailureAttempt[] = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    // Generate once, then Modify before each retry — the plan's `Generate → Test → FAIL /
    // Modify → Test → FAIL / Modify → Test → FAIL`, in that order.
    const authoring = attempt === 1 ? 'generate' : 'modify';
    await runAuthoringStep(run, provider, authoring, attempt);
    attempts.push(runTestStep(run, clock, attempt));
  }

  run.complete({ status: 'FAILED' });
  await telemetry.flush();
  const telemetryStats = telemetry.stats();
  await telemetry.shutdown();

  return { runId: run.runId, status: 'FAILED', attempts, telemetryStats };
}

/** Generate or Modify: one `MockProvider` call, recorded as a ModelCall on its own step. */
async function runAuthoringStep(
  run: RunHandle,
  provider: MockProvider,
  name: 'generate' | 'modify',
  attempt: number,
): Promise<void> {
  const step = run.startStep({ name, agentName: AGENT_NAME, type: name });
  const response: MockProviderResponse = await provider.invoke({ step: name, callIndex: attempt });
  step.recordModelCall({
    provider: response.provider,
    model: response.model,
    latencyMs: response.latencyMs,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    status: 'success',
  });
  step.complete({ status: 'COMPLETED', metadata: { detail: response.detail } });
}

/**
 * One Test step: the same tool, the same input, failing the same way. Both timestamps come
 * from the run's own clock, so `durationMs` is the clock's step and is reproducible under a
 * seed.
 */
function runTestStep(run: RunHandle, clock: Clock, attempt: number): RepeatedFailureAttempt {
  const step: StepHandle = run.startStep({ name: 'test', agentName: AGENT_NAME, type: 'test' });
  const startedAt = clock.now();
  const completedAt = clock.now();
  const toolCallId = step.recordToolCall({
    toolName: TOOL_NAME,
    input: TOOL_INPUT,
    output: TOOL_OUTPUT,
    startedAt,
    completedAt,
    success: false,
    error: FAILURE_MESSAGE,
  });
  step.recordError({
    type: ERROR_TYPE,
    message: FAILURE_MESSAGE,
    metadata: { toolName: TOOL_NAME, attempt },
  });
  step.complete({ status: 'FAILED' });

  return {
    attempt,
    toolCallId,
    toolName: TOOL_NAME,
    inputFingerprint: fingerprintOf(TOOL_INPUT),
    success: false,
    error: FAILURE_MESSAGE,
  };
}
