/**
 * Seam: `runRepeatedFailureScenario` → the envelopes the SDK actually hands its transport.
 *
 * The scenario's own return value and the wire are two different claims. A scenario that
 * built a tidy `attempts` array and emitted two tool calls would satisfy the first and fail
 * the second, so every §20.2 condition is asserted against `tool_call.recorded` payloads
 * rather than against `result.attempts` — the array is only used to state what the
 * fingerprint is expected to be, and that value is sourced from the SDK's own
 * `fingerprintOf` over the frozen input, never copied from the emission it checks.
 *
 * Observed at `RecordingTransport` rather than against a live API: the assertions are about
 * what this scenario emits, which is a property of the scenario, not of whether anything was
 * listening. The command's behaviour against a real endpoint is `p7.e2e`'s and
 * `p7.docker-smoke`'s.
 *
 * No assertion here says `REPEATED_FAILED_ACTION`. `../scenario.ts`'s "What this file does
 * NOT do" applies to its tests too — a hand-rolled verdict in this directory would be a
 * second definition of the analyzer, free to disagree with the one the product ships.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fingerprintOf } from '@lengentic/telemetry-sdk';

import { FAILURE_MESSAGE, runRepeatedFailureScenario, TOOL_INPUT, TOOL_NAME } from '../scenario';
import { RecordingTransport, type RecordedEnvelope } from './support/recording-transport';

const SEED = 4_321;

/**
 * �20.2's floor: three consecutive failed attempts. A literal on purpose, not the
 * production `ATTEMPTS`: asserting `calls.length === ATTEMPTS` is a tautology that stays
 * green when `ATTEMPTS` is lowered to 2 (wave-gate F2, mutant M2a). The requirement is
 * pinned here, independent of the module under test.
 */
const REQUIRED_ATTEMPTS = 3;

interface ToolCallRecordedPayload {
  readonly toolName: string;
  readonly input?: unknown;
  readonly success: boolean;
  readonly error?: string | null;
}

interface ErrorRecordedPayload {
  readonly message: string;
}

function eventsOfType(events: readonly RecordedEnvelope[], type: string): RecordedEnvelope[] {
  return events.filter((event) => event.type === type);
}

async function emit(seed: number = SEED): Promise<{
  transport: RecordingTransport;
  result: Awaited<ReturnType<typeof runRepeatedFailureScenario>>;
}> {
  const transport = new RecordingTransport();
  const result = await runRepeatedFailureScenario({ seed, telemetryConfig: { transport } });
  return { transport, result };
}

function toolCalls(transport: RecordingTransport): ToolCallRecordedPayload[] {
  return eventsOfType(transport.allEvents, 'tool_call.recorded').map(
    (event) => event.payload as ToolCallRecordedPayload,
  );
}

void describe('runRepeatedFailureScenario — what reaches the wire', () => {
  void it('emits exactly the �20.2 floor of 3 tool calls, all of them the same tool', async () => {
    const { transport, result } = await emit();
    const calls = toolCalls(transport);

    assert.equal(calls.length, REQUIRED_ATTEMPTS);
    assert.equal(result.attempts.length, REQUIRED_ATTEMPTS);
    assert.deepEqual([...new Set(calls.map((call) => call.toolName))], [TOOL_NAME]);
  });

  void it('emits one runId for the whole streak — §20.2 "Same runId"', async () => {
    const { transport, result } = await emit();
    const runIds = new Set(transport.allEvents.map((event) => event.runId));

    assert.equal(runIds.size, 1);
    assert.deepEqual([...runIds], [result.runId]);
    assert.equal(eventsOfType(transport.allEvents, 'run.started').length, 1);
    assert.equal(eventsOfType(transport.allEvents, 'run.completed').length, 1);
  });

  void it('records the same input on every attempt, so one fingerprint covers the streak', async () => {
    const { transport, result } = await emit();
    const expected = fingerprintOf(TOOL_INPUT);
    const emittedFingerprints = new Set(
      toolCalls(transport).map((call) => fingerprintOf(call.input)),
    );

    assert.equal(emittedFingerprints.size, 1);
    assert.deepEqual([...emittedFingerprints], [expected]);
    // The reported fingerprint has to be the one the wire supports, not an independent one.
    assert.deepEqual(
      [...new Set(result.attempts.map((attempt) => attempt.inputFingerprint))],
      [expected],
    );
  });

  void it('fails every attempt with no success between them, and records an Error beside each', async () => {
    const { transport } = await emit();
    const calls = toolCalls(transport);
    const errors = eventsOfType(transport.allEvents, 'error.recorded').map(
      (event) => event.payload as ErrorRecordedPayload,
    );

    assert.equal(
      calls.filter((call) => call.success).length,
      0,
      'a successful attempt between failures breaks §20.2’s streak',
    );
    assert.deepEqual([...new Set(calls.map((call) => call.error))], [FAILURE_MESSAGE]);
    assert.equal(errors.length, REQUIRED_ATTEMPTS);
    assert.deepEqual([...new Set(errors.map((error) => error.message))], [FAILURE_MESSAGE]);
  });

  void it('completes the run FAILED — the run fails, which is the scenario succeeding', async () => {
    const { transport, result } = await emit();
    const completed = eventsOfType(transport.allEvents, 'run.completed')[0];

    assert.equal(result.status, 'FAILED');
    assert.equal((completed?.payload as { status: string } | undefined)?.status, 'FAILED');
  });

  void it('is reproducible under a seed: same runId, same eventIds, same envelopes', async () => {
    const first = await emit(SEED);
    const second = await emit(SEED);

    assert.deepEqual(second.transport.allEvents, first.transport.allEvents);
    assert.equal(second.result.runId, first.result.runId);
  });

  void it('derives runId and eventIds from the seed � a different seed shares none of them', async () => {
    const first = await emit(SEED);
    const other = await emit(SEED + 1);

    // Compared on ids specifically: whole-envelope inequality is also satisfied by
    // `metadata.seed` alone, which proves nothing about id derivation (wave-gate F2, M2e).
    assert.notEqual(other.result.runId, first.result.runId);
    const firstEventIds = new Set(first.transport.allEvents.map((event) => event.eventId));
    const otherEventIds = other.transport.allEvents.map((event) => event.eventId);
    assert.ok(otherEventIds.length > 0);
    assert.deepEqual(
      otherEventIds.filter((eventId) => firstEventIds.has(eventId)),
      [],
    );
    const firstRunIds = new Set(first.transport.allEvents.map((event) => event.runId));
    assert.deepEqual(
      [...new Set(other.transport.allEvents.map((event) => event.runId))].filter((id) =>
        firstRunIds.has(id),
      ),
      [],
    );
  });

  void it('derives timestamps from the seed � a different seed starts at a different instant', async () => {
    const first = await emit(SEED);
    const other = await emit(SEED + 1);

    // `occurredAt` may be a Date: compare the instant, never object identity.
    const instantOf = (events: readonly { readonly occurredAt: unknown }[]): number =>
      new Date(events[0]?.occurredAt as string | number | Date).getTime();
    const firstInstant = instantOf(first.transport.allEvents);
    assert.ok(Number.isFinite(firstInstant));
    assert.notEqual(instantOf(other.transport.allEvents), firstInstant);
  });

  void it('flushes and shuts down, so the reported stats cover the whole run', async () => {
    const { transport, result } = await emit();

    assert.equal(result.telemetryStats.recorded, transport.allEvents.length);
    assert.equal(result.telemetryStats.delivered, transport.allEvents.length);
    assert.equal(result.telemetryStats.droppedUndeliverable, 0);
  });
});
