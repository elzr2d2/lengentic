/**
 * Scenario 3 — Repeated Decision (`MVP_PLAN_V3.md` Phase 6, work package 2), plus §25 beat
 * 6's low-diversity suppression control.
 *
 * ```text
 * Decision:  run_tests_after_code_change
 * Selected:  YES (dominant)
 *
 * >= 30 runs spanning >= 8 distinct contextKeys, 1-2 minority selections attested SUCCESS
 * Expected: DETERMINISTIC_CANDIDATE with a non-empty counterexamples list
 *
 * ...and, from the same command, a second cohort:
 * Enough samples to clear G1, EXACTLY two distinct contextKeys
 * Expected: SUPPRESSED, G2 among the failed gates, NO Recommendation row persisted
 * ```
 *
 * The two cohorts and the arithmetic behind their counts are `./cohorts.ts`. This module is
 * only the emitter: it turns each expanded `CohortSample` into one real Run carrying one
 * real Decision, through the Telemetry SDK's public entry.
 *
 * ## One run per sample, one client per run, one process
 *
 * "Scenario 3 runs in one CLI process, emits at least 30 runs, and spawns no child process"
 * (Phase 6 DoD). Each sample is its own Run because §25's `Samples: 48` counts decisions
 * across runs — fifty decisions inside one run would be one run's worth of evidence wearing
 * a sample count. Each Run owns its own `TelemetryClient` and performs its own flush and
 * shutdown, which is `MockAgent`'s documented one-run-one-client contract
 * (`playground/agents/mock-agent.ts`) held to from the outside; the graph node's note
 * forbids refactoring `MockAgent` into an externally owned shared-client architecture, and
 * this file does the opposite of asking for one. `await` between runs means at most one
 * client is ever live, and nothing here spawns a process.
 *
 * ## Why not `MockAgent`
 *
 * `MockAgent` drives `Start -> Plan -> Execute -> Validate -> Complete` and emits exactly one
 * decision — `execution_strategy`, as Step metadata (`recordStrategyDecision`, and its own
 * doc on why it is not yet a Decision entity). It exposes no seam for recording a
 * `run_tests_after_code_change` Decision or attesting its outcome, and
 * `playground/agents/**` is outside this packet's `allowed_paths`. So this scenario composes
 * the same two seams `MockAgent` does — `createSeededComponents` (`../../determinism`) and
 * `createPlaygroundTelemetry` (`../../index`) — directly, exactly as
 * `../repeated-failure/scenario.ts` does for the same reason. The composition root stays the
 * one place the Playground names the SDK.
 *
 * ## What this file does NOT do
 *
 * It never decides whether the analyzer would emit `DETERMINISTIC_CANDIDATE` or
 * `SUPPRESSED`. `playground-not-to-analysis-engine` (`pnpm check:boundaries`) exists because
 * a Playground that could import the analyzer could shape its telemetry to satisfy it. What
 * this scenario reports is what it *emitted* — per cohort, the group key, the sample count,
 * the distinct contexts, the option distribution and which decisions were attested with what
 * outcome — and the caller reads that emission, never a verdict. Proving §20.1 fires on this
 * data is `p7.e2e`'s assertion.
 *
 * ## Determinism
 *
 * Every run's seed is `(seed + globalIndex) | 0`, so the whole workload is a pure function of
 * the one `--seed` the CLI exposes: same seed, same runIds, same decisionIds, same
 * timestamps, byte-identical envelopes. The offsets are distinct for distinct indices (adding
 * 1..66 to a wrapping int32 stays injective), so no two runs collide on a runId and get
 * silently deduplicated by the server's `(runId, eventId)` ledger key.
 */
import { createSeededComponents, namespacedSeed, type SeededClockOptions } from '../../determinism';
import { createPlaygroundTelemetry, type TelemetryClient, type TelemetryConfig } from '../../index';
import { MockProvider } from '../../providers';

import {
  COHORTS,
  distinctContextKeys,
  expandCohort,
  type CohortOutcome,
  type CohortSample,
  type CohortSpec,
} from './cohorts';

type RunHandle = ReturnType<TelemetryClient['startRun']>;
type TelemetryStats = ReturnType<TelemetryClient['stats']>;

const AGENT_NAME = 'deterministic-decision-agent';

/** Folded into the id/clock seed so this scenario's keys are disjoint from the others'. */
const SCENARIO_NAMESPACE = 'deterministic-decision';

/** The one step every run has: the decision point itself. */
const DECISION_STEP = 'decide';

export interface DeterministicDecisionScenarioOptions {
  readonly seed: number;
  /** Passed through to the telemetry client — endpoint, transport, `maxRetries`, … */
  readonly telemetryConfig?: TelemetryConfig;
  readonly clockOptions?: SeededClockOptions;
}

/** One emitted Run, as it was recorded. */
export interface EmittedDecision {
  readonly runId: string;
  readonly decisionId: string;
  readonly contextKey: string;
  readonly selectedOption: string;
  /** `UNKNOWN` means no `decision.outcome_attested` event was emitted for this decision at
   *  all — §14's state of a decision nobody has attested, not an attested value. */
  readonly outcome: CohortOutcome;
}

/** What one cohort actually put on the wire. Measurements only — no verdict (module doc). */
export interface CohortEmission {
  readonly id: string;
  readonly label: string;
  /** §18's group key, verbatim: these four fields and nothing else. */
  readonly groupKey: {
    readonly workflowName: string;
    readonly workflowVersion: string;
    readonly decisionType: string;
    readonly contextKeyVersion: string;
  };
  readonly sampleCount: number;
  readonly distinctContextKeys: readonly string[];
  /** Emission order, one entry per Run. */
  readonly decisions: readonly EmittedDecision[];
}

export interface DeterministicDecisionScenarioResult {
  readonly cohorts: readonly CohortEmission[];
  /** Total Runs emitted across every cohort — the DoD's "at least 30 runs". */
  readonly runCount: number;
  /** Summed across every per-run client, since each run owns and shuts down its own. */
  readonly telemetryStats: TelemetryStats;
}

/**
 * Emits both cohorts and returns once the last run's telemetry has been flushed and its
 * client shut down.
 *
 * `MockProvider` supplies each decision step's model call with the failure knobs at their
 * defaults (`failureRate: 0`): the `FAILURE` outcomes in these cohorts are *attested
 * outcomes of the decision*, not provider failures. A decision that ran the tests and found
 * a real bug is a `run_tests_after_code_change = YES` that worked; the attested `FAILURE`
 * rows here are the ones where running the tests did not turn out to be the right call. That
 * distinction is §14's whole point — LenGentic observes the attestation, never the
 * counterfactual — so nothing about the provider is made to fail to represent it.
 */
export async function runDeterministicDecisionScenario(
  options: DeterministicDecisionScenarioOptions,
): Promise<DeterministicDecisionScenarioResult> {
  const cohorts: CohortEmission[] = [];
  const stats: TelemetryStats[] = [];
  let globalIndex = 0;

  for (const spec of COHORTS) {
    const samples = expandCohort(spec);
    const decisions: EmittedDecision[] = [];
    for (const sample of samples) {
      const emitted = await emitSample(spec, sample, seedFor(options.seed, globalIndex), options);
      globalIndex += 1;
      decisions.push(emitted.decision);
      stats.push(emitted.telemetryStats);
    }
    cohorts.push({
      id: spec.id,
      label: spec.label,
      groupKey: {
        workflowName: spec.workflowName,
        workflowVersion: spec.workflowVersion,
        decisionType: spec.decisionType,
        contextKeyVersion: spec.contextKeyVersion,
      },
      sampleCount: samples.length,
      distinctContextKeys: distinctContextKeys(samples),
      decisions,
    });
  }

  return { cohorts, runCount: globalIndex, telemetryStats: sumStats(stats) };
}

/**
 * Per-run seed. `| 0` keeps the value inside the 32-bit signed range `createSeededComponents`
 * validates (R4, `playground/determinism/seed.ts`) instead of throwing on a large `--seed`,
 * and stays injective over the few dozen offsets this scenario uses.
 */
export function seedFor(baseSeed: number, index: number): number {
  return (baseSeed + index) | 0;
}

/** One sample: one Run, one Step, one ModelCall, one Decision, and — unless the sample's
 *  outcome is `UNKNOWN` — one attestation. */
async function emitSample(
  spec: CohortSpec,
  sample: CohortSample,
  seed: number,
  options: DeterministicDecisionScenarioOptions,
): Promise<{ decision: EmittedDecision; telemetryStats: TelemetryStats }> {
  // Ids and clock are namespaced by scenario (wave-gate F1); the provider keeps the raw
  // per-run seed.
  const { clock, idGenerator } = createSeededComponents(
    namespacedSeed(SCENARIO_NAMESPACE, seed),
    options.clockOptions,
  );
  const telemetry = createPlaygroundTelemetry({
    ...(options.telemetryConfig ?? {}),
    clock,
    idGenerator,
  });
  const provider = new MockProvider({ seed, delayMs: 0, failureRate: 0 });

  const run: RunHandle = telemetry.startRun({
    workflowName: spec.workflowName,
    workflowVersion: spec.workflowVersion,
    metadata: { scenario: 'deterministic-decision', cohort: spec.id, seed },
  });

  const step = run.startStep({ name: DECISION_STEP, agentName: AGENT_NAME, type: 'decision' });
  const response = await provider.invoke({ step: DECISION_STEP, callIndex: sample.index });
  step.recordModelCall({
    provider: response.provider,
    model: response.model,
    latencyMs: response.latencyMs,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    status: 'success',
  });

  // ADR 0003: `contextKey` is caller-computed and never inferred by the SDK. `rawContext`
  // carries the situation the key summarizes — `contextVariation` is `MockProvider`'s own
  // per-request variation, a fact about this run rather than a constant restated here.
  const decision = step.recordDecision({
    decisionType: spec.decisionType,
    contextKey: sample.contextKey,
    contextKeyVersion: spec.contextKeyVersion,
    rawContext: { contextVariation: response.contextVariation },
    availableOptions: spec.availableOptions,
    selectedOption: sample.selectedOption,
  });
  step.complete({ status: 'COMPLETED', metadata: { detail: response.detail } });

  // §14: attestation is an independent, idempotent event, and `UNKNOWN` is the state of a
  // decision nobody has attested — so an `UNKNOWN` sample emits no attestation rather than
  // attesting the value `UNKNOWN`. That absence is exactly what keeps `outcomeCoverage`
  // below 1 and G5 satisfiable (§18 "Explicit denominators").
  if (sample.outcome !== 'UNKNOWN') {
    decision.attestOutcome(sample.outcome, { observedAt: clock.now() });
  }

  // COMPLETED, always: §39's STALE rule excludes a RUNNING run with no recent event, and a
  // stale run's decisions are excluded from every group (§18 `eligible`). The *decision's*
  // attested outcome is the scenario's variable; the run's status is not.
  run.complete({ status: 'COMPLETED' });
  await telemetry.flush();
  const telemetryStats = telemetry.stats();
  await telemetry.shutdown();

  return {
    decision: {
      runId: run.runId,
      decisionId: decision.decisionId,
      contextKey: sample.contextKey,
      selectedOption: sample.selectedOption,
      outcome: sample.outcome,
    },
    telemetryStats,
  };
}

/** Adds the per-run clients' counters field by field. Every `TelemetryStats` member is a
 *  count, so the sum of N single-run clients is what one client would have reported had the
 *  scenario been able to use one — which is the number a reader of the summary wants. */
function sumStats(all: readonly TelemetryStats[]): TelemetryStats {
  const zero: TelemetryStats = {
    queued: 0,
    recorded: 0,
    delivered: 0,
    droppedOverflow: 0,
    droppedInvalid: 0,
    droppedTooLarge: 0,
    droppedAfterShutdown: 0,
    droppedUndeliverable: 0,
    deliveryFailures: 0,
    serverAccepted: 0,
    serverDuplicate: 0,
    serverRejected: 0,
    serverCountsUnavailable: 0,
  };
  return all.reduce<TelemetryStats>(
    (total, stats) => ({
      queued: total.queued + stats.queued,
      recorded: total.recorded + stats.recorded,
      delivered: total.delivered + stats.delivered,
      droppedOverflow: total.droppedOverflow + stats.droppedOverflow,
      droppedInvalid: total.droppedInvalid + stats.droppedInvalid,
      droppedTooLarge: total.droppedTooLarge + stats.droppedTooLarge,
      droppedAfterShutdown: total.droppedAfterShutdown + stats.droppedAfterShutdown,
      droppedUndeliverable: total.droppedUndeliverable + stats.droppedUndeliverable,
      deliveryFailures: total.deliveryFailures + stats.deliveryFailures,
      serverAccepted: total.serverAccepted + stats.serverAccepted,
      serverDuplicate: total.serverDuplicate + stats.serverDuplicate,
      serverRejected: total.serverRejected + stats.serverRejected,
      serverCountsUnavailable: total.serverCountsUnavailable + stats.serverCountsUnavailable,
    }),
    zero,
  );
}
