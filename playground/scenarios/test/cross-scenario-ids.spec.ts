/**
 * Seam: the three scenario entry points → the envelopes the SDK hands its transport,
 * compared *across* scenarios.
 *
 * The server dedups on the `(runId, eventId)` ledger key. Every other test in this package
 * checks one scenario against itself; none can see two scenarios minting the same key, which
 * is what happened at the shared default seed 42 (Phase 6 wave-gate F1: Scenario 2 and
 * Scenario 3 emitted the same runId and five shared `(runId, eventId)` keys, so posting both
 * to one API would silently merge or drop events).
 *
 * The expected value is "empty intersection", derived from the dedup rule, not from any
 * emitted value. Each scenario is driven through its own public runner with the same `seed`
 * — the only thing a caller of the three CLIs shares.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MockAgent } from '../../agents';
import { runDeterministicDecisionScenario } from '../deterministic-decision/scenario';
import { runRepeatedFailureScenario } from '../repeated-failure/scenario';
import { RecordingTransport, type RecordedEnvelope } from './support/recording-transport';

/** `parseSeed`'s default in `playground/cli/happy-path.ts`, which both scenario CLIs share. */
const DEFAULT_SEED = 42;
const OTHER_SEED = 7;

type ScenarioName = 'happy-path' | 'repeated-failure' | 'deterministic-decision';

async function emit(scenario: ScenarioName, seed: number): Promise<readonly RecordedEnvelope[]> {
  const transport = new RecordingTransport();
  const telemetryConfig = { transport };
  switch (scenario) {
    case 'happy-path':
      await new MockAgent({ seed, telemetryConfig }).run();
      break;
    case 'repeated-failure':
      await runRepeatedFailureScenario({ seed, telemetryConfig });
      break;
    case 'deterministic-decision':
      await runDeterministicDecisionScenario({ seed, telemetryConfig });
      break;
  }
  return transport.allEvents;
}

function ledgerKeys(events: readonly RecordedEnvelope[]): Set<string> {
  return new Set(events.map((event) => `${event.runId}/${event.eventId}`));
}

function runIds(events: readonly RecordedEnvelope[]): Set<string> {
  return new Set(events.map((event) => event.runId));
}

const SCENARIOS: readonly ScenarioName[] = [
  'happy-path',
  'repeated-failure',
  'deterministic-decision',
];

for (const seed of [DEFAULT_SEED, OTHER_SEED]) {
  void describe(`three scenarios at seed ${seed} — one server, one (runId, eventId) ledger`, () => {
    void it('emit something each, so an empty intersection is not vacuous', async () => {
      for (const scenario of SCENARIOS) {
        const events = await emit(scenario, seed);
        assert.ok(events.length > 0, `${scenario} emitted no events`);
        assert.equal(ledgerKeys(events).size, events.length, `${scenario} repeats its own key`);
      }
    });

    void it('share no (runId, eventId) key and no runId', async () => {
      const emitted = new Map<ScenarioName, readonly RecordedEnvelope[]>();
      for (const scenario of SCENARIOS) emitted.set(scenario, await emit(scenario, seed));

      for (const [index, left] of SCENARIOS.entries()) {
        for (const right of SCENARIOS.slice(index + 1)) {
          const leftEvents = emitted.get(left) ?? [];
          const rightEvents = emitted.get(right) ?? [];
          const rightKeys = ledgerKeys(rightEvents);
          const sharedKeys = [...ledgerKeys(leftEvents)].filter((key) => rightKeys.has(key));
          assert.deepEqual(sharedKeys, [], `${left} and ${right} share (runId/eventId) keys`);

          const rightRuns = runIds(rightEvents);
          const sharedRuns = [...runIds(leftEvents)].filter((id) => rightRuns.has(id));
          assert.deepEqual(sharedRuns, [], `${left} and ${right} share a runId`);
        }
      }
    });
  });
}
