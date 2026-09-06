/**
 * Seam: `runDeterministicDecisionScenario` → the envelopes the SDK actually hands its
 * transport.
 *
 * `../cohorts.ts`'s tests check the *plan*: the declared counts satisfy §19's arithmetic.
 * This file checks the *emission*: that the runs and decisions actually reaching the wire
 * carry those same counts, contexts, options and attestations. A cohort spec that satisfies
 * every gate on paper and a scenario that emits half of it would pass the first file and
 * fail this one.
 *
 * Observed at `RecordingTransport` rather than against a live API: the assertions are about
 * what this scenario emits, which is a property of the scenario, not of whether anything was
 * listening. The command's behaviour against a real endpoint is `p7.e2e`'s and
 * `p7.docker-smoke`'s.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CANDIDATE_COHORT, CONTROL_COHORT, expandCohort, MINORITY_CONTEXT } from '../cohorts';
import { runDeterministicDecisionScenario, seedFor } from '../scenario';
import { RecordingTransport, type RecordedEnvelope } from './support/recording-transport';

const SEED = 4_321;

interface DecisionRecordedPayload {
  readonly decisionType: string;
  readonly contextKey?: string | null;
  readonly contextKeyVersion?: string | null;
  readonly selectedOption: string;
  readonly availableOptions: readonly string[];
}

interface OutcomeAttestedPayload {
  readonly outcome: string;
}

function eventsOfType(events: readonly RecordedEnvelope[], type: string): RecordedEnvelope[] {
  return events.filter((event) => event.type === type);
}

async function emit(): Promise<{
  transport: RecordingTransport;
  result: Awaited<ReturnType<typeof runDeterministicDecisionScenario>>;
}> {
  const transport = new RecordingTransport();
  const result = await runDeterministicDecisionScenario({
    seed: SEED,
    telemetryConfig: { transport },
  });
  return { transport, result };
}

void describe('runDeterministicDecisionScenario — what reaches the wire', () => {
  void it('emits one run and one decision per declared sample, in one process', async () => {
    const { transport, result } = await emit();
    const expected = expandCohort(CANDIDATE_COHORT).length + expandCohort(CONTROL_COHORT).length;

    assert.equal(result.runCount, expected);
    assert.equal(eventsOfType(transport.allEvents, 'run.started').length, expected);
    assert.equal(eventsOfType(transport.allEvents, 'run.completed').length, expected);
    assert.equal(eventsOfType(transport.allEvents, 'decision.recorded').length, expected);
    // The DoD's floor, asserted on the emission rather than on the spec.
    assert.ok(result.runCount >= 30, `${result.runCount} runs < 30`);
  });

  void it('gives every run a distinct runId, so none is deduplicated away', async () => {
    const { result } = await emit();
    const runIds = result.cohorts.flatMap((cohort) =>
      cohort.decisions.map((decision) => decision.runId),
    );
    // The server's ledger key is `(runId, eventId)`: two runs colliding on a runId would be
    // silently accepted and counted once, turning N samples into fewer without an error
    // anywhere (F1, `.artifacts/evidence/3/phase-gate/tester/README.md`).
    assert.equal(new Set(runIds).size, runIds.length);
  });

  void it('attests exactly the non-UNKNOWN samples, and attests nothing else', async () => {
    const { transport, result } = await emit();
    const declaredAttested = [
      ...expandCohort(CANDIDATE_COHORT),
      ...expandCohort(CONTROL_COHORT),
    ].filter((sample) => sample.outcome !== 'UNKNOWN');

    const attestations = eventsOfType(transport.allEvents, 'decision.outcome_attested');
    assert.equal(attestations.length, declaredAttested.length);

    const emittedOutcomes = attestations
      .map((event) => (event.payload as OutcomeAttestedPayload).outcome)
      .sort();
    assert.deepEqual(emittedOutcomes, declaredAttested.map((sample) => sample.outcome).sort());

    // §14: `UNKNOWN` is the state of a decision nobody has attested. Emitting it as a value
    // would make `outcomeCoverage` 100% and G5 unsatisfiable (§18).
    assert.ok(!emittedOutcomes.includes('UNKNOWN'));

    const unknownCount = result.cohorts
      .flatMap((cohort) => cohort.decisions)
      .filter((decision) => decision.outcome === 'UNKNOWN').length;
    assert.ok(unknownCount > 0, 'no UNKNOWN samples emitted — G5 would be vacuous');
  });

  void it('carries the candidate cohort group key, contexts and options on every decision', async () => {
    const { transport } = await emit();
    const candidate = eventsOfType(transport.allEvents, 'decision.recorded')
      .map((event) => event.payload as DecisionRecordedPayload)
      .filter((payload) => payload.decisionType === CANDIDATE_COHORT.decisionType);

    const contexts = new Set<string>();
    for (const payload of candidate) {
      assert.equal(payload.contextKeyVersion, CANDIDATE_COHORT.contextKeyVersion);
      assert.deepEqual([...payload.availableOptions], [...CANDIDATE_COHORT.availableOptions]);
      assert.ok(payload.contextKey != null && payload.contextKey !== '');
      contexts.add(payload.contextKey);
    }
    // Both cohorts share `decisionType`, so this set spans both groups; the per-cohort
    // context counts are asserted from the result below, where the group key is known.
    assert.ok(contexts.has(MINORITY_CONTEXT));
  });

  void it('reports per-cohort contexts matching the declared cohorts', async () => {
    const { result } = await emit();
    const byId = new Map(result.cohorts.map((cohort) => [cohort.id, cohort]));

    const candidate = byId.get(CANDIDATE_COHORT.id);
    assert.ok(candidate !== undefined);
    assert.equal(candidate.groupKey.workflowName, CANDIDATE_COHORT.workflowName);
    assert.ok(
      candidate.distinctContextKeys.length >= 8,
      `candidate cohort spans ${candidate.distinctContextKeys.length} contexts, < 8`,
    );

    const control = byId.get(CONTROL_COHORT.id);
    assert.ok(control !== undefined);
    assert.equal(control.groupKey.workflowName, CONTROL_COHORT.workflowName);
    assert.equal(control.distinctContextKeys.length, 2);
    assert.ok(control.sampleCount >= 30, `control cohort has ${control.sampleCount} samples, < 30`);
  });

  void it('completes every run, so none derives as STALE and gets excluded', async () => {
    const { transport } = await emit();
    const completed = eventsOfType(transport.allEvents, 'run.completed');
    const started = eventsOfType(transport.allEvents, 'run.started');
    assert.deepEqual(
      new Set(completed.map((event) => event.runId)),
      new Set(started.map((event) => event.runId)),
    );
  });

  void it('drops nothing on the way to the transport', async () => {
    const { transport, result } = await emit();
    const stats = result.telemetryStats;
    assert.equal(stats.droppedInvalid, 0);
    assert.equal(stats.droppedOverflow, 0);
    assert.equal(stats.droppedTooLarge, 0);
    assert.equal(stats.droppedUndeliverable, 0);
    assert.equal(stats.droppedAfterShutdown, 0);
    assert.equal(stats.delivered, transport.allEvents.length);
  });
});

void describe('determinism (§17)', () => {
  void it('same seed → byte-identical envelopes', async () => {
    const first = new RecordingTransport();
    const second = new RecordingTransport();
    await runDeterministicDecisionScenario({ seed: SEED, telemetryConfig: { transport: first } });
    await runDeterministicDecisionScenario({ seed: SEED, telemetryConfig: { transport: second } });

    assert.deepEqual(first.allEvents, second.allEvents);
  });

  void it('different seed → different ids', async () => {
    const first = new RecordingTransport();
    const second = new RecordingTransport();
    await runDeterministicDecisionScenario({ seed: SEED, telemetryConfig: { transport: first } });
    await runDeterministicDecisionScenario({
      seed: SEED + 1_000,
      telemetryConfig: { transport: second },
    });

    const firstIds = new Set(first.allEvents.map((event) => event.eventId));
    const overlap = second.allEvents.filter((event) => firstIds.has(event.eventId));
    assert.equal(overlap.length, 0);
  });

  void it('derives per-run seeds that stay distinct and inside the 32-bit range', () => {
    const seeds = Array.from({ length: 100 }, (_, index) => seedFor(2_147_483_600, index));
    assert.equal(new Set(seeds).size, seeds.length);
    for (const seed of seeds) {
      assert.ok(Number.isInteger(seed) && seed >= -2_147_483_648 && seed <= 2_147_483_647);
    }
  });
});
