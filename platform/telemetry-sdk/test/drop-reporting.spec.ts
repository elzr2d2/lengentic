import type { TelemetryEventEnvelope } from '@lengentic/shared';
import { describe, expect, it } from 'vitest';

import { createTelemetryClient, type StepHandle, type TelemetryClient } from '../src/index';
import type { TelemetryTransport, TransportResult } from '../src/transport';
import { FakeScheduler, settle } from './support/fake-scheduler';
import { FailingTransport, GatedTransport, RecordingTransport } from './support/test-transports';

/**
 * ADR 0014 decision 2 put an optional batch-level `droppedSinceLastBatch` on
 * `IngestRequestSchema` and nothing sent it, so DoD line 6 ("the dropped-event count is
 * visible in the Dashboard") was reachable only by a hand-built request. These are the
 * seams that make the SDK's §16 drop counters reach that field.
 *
 * Seams under test: the public client observed through the INJECTED transport — the
 * `options.droppedSinceLastBatch` the client actually handed over, per attempt. The wire
 * shape itself is `http-transport.spec.ts`, against a real socket.
 *
 * Expected values come from arithmetic on drops the test caused deliberately, never from a
 * number read back out of the client. Each oversized tool call is exactly one
 * `event_too_large` drop (the same shape `resilience.spec.ts` uses), so a test that expects
 * 2 caused 2.
 */
const fixedClock = { now: () => new Date('2026-09-03T00:00:00.000Z') };

const RETRYABLE = { outcome: 'retryable', detail: 'connection refused' } as const;
const PERMANENT = { outcome: 'permanent', detail: 'HTTP 400' } as const;

function stepOf(client: TelemetryClient): StepHandle {
  return client
    .startRun({ workflowName: 'w', workflowVersion: 'v' })
    .startStep({ name: 's', agentName: 'a', type: 'execute' });
}

/** Causes exactly one drop, and enqueues nothing: the event never passes `checkEnvelope`. */
function dropOne(step: StepHandle): void {
  step.recordToolCall({
    toolName: 'read_file',
    input: 'x'.repeat(64 * 1024),
    output: 'y'.repeat(64 * 1024),
    startedAt: fixedClock.now(),
    completedAt: fixedClock.now(),
    success: true,
  });
}

/**
 * Fails every attempt, and lets the test cause a drop BETWEEN attempts — the host process
 * does not stop recording just because a retry is pending. Without that, "snapshotted once"
 * and "re-read per attempt" produce identical numbers and the test proves nothing.
 */
class RetryingTransport implements TelemetryTransport {
  readonly dropReports: Array<number | undefined> = [];
  readonly deliveryIds: Array<string | undefined> = [];

  attempts = 0;

  constructor(private readonly betweenAttempts: () => void) {}

  send(
    _events: readonly TelemetryEventEnvelope[],
    options: {
      readonly droppedSinceLastBatch?: number | undefined;
      readonly deliveryId?: string | undefined;
    },
  ): Promise<TransportResult> {
    this.attempts += 1;
    this.dropReports.push(options.droppedSinceLastBatch);
    this.deliveryIds.push(options.deliveryId);
    this.betweenAttempts();
    return Promise.resolve(RETRYABLE);
  }
}

/** Hands out a scripted result per attempt, and records the snapshot each one carried. */
class ScriptedTransport implements TelemetryTransport {
  readonly dropReports: Array<number | undefined> = [];
  readonly deliveryIds: Array<string | undefined> = [];

  constructor(private readonly results: TransportResult[]) {}

  send(
    _events: readonly TelemetryEventEnvelope[],
    options: {
      readonly droppedSinceLastBatch?: number | undefined;
      readonly deliveryId?: string | undefined;
    },
  ): Promise<TransportResult> {
    this.dropReports.push(options.droppedSinceLastBatch);
    this.deliveryIds.push(options.deliveryId);
    return Promise.resolve(this.results.shift() ?? { outcome: 'delivered', response: null });
  }
}

describe('reporting drops to the batch-level droppedSinceLastBatch', () => {
  it('reports a genuine 0 when nothing has been dropped — never omits the field', async () => {
    const transport = new RecordingTransport();
    const client = createTelemetryClient({
      transport,
      scheduler: new FakeScheduler(),
      clock: fixedClock,
    });

    client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    await client.flush();

    // 0, not undefined: `undefined` is what an SDK built before the field sends, and the
    // Dashboard must keep reading that as "not reported".
    expect(transport.dropReports).toStrictEqual([0]);
    expect(client.stats().droppedTooLarge).toBe(0);
  });

  it('carries the drops that happened before the batch', async () => {
    const transport = new RecordingTransport();
    const client = createTelemetryClient({
      transport,
      scheduler: new FakeScheduler(),
      clock: fixedClock,
    });

    const step = stepOf(client); // run.started + step.started queued
    dropOne(step);
    dropOne(step);
    await client.flush();

    expect(client.stats().droppedTooLarge).toBe(2);
    expect(transport.batches.length).toBe(1);
    expect(transport.dropReports).toStrictEqual([2]);
  });

  it('never double-counts across consecutive successful batches', async () => {
    const transport = new RecordingTransport();
    const client = createTelemetryClient({
      transport,
      scheduler: new FakeScheduler(),
      clock: fixedClock,
    });

    const step = stepOf(client);
    dropOne(step);
    await client.flush();

    step.complete();
    await client.flush();

    // The second batch had no NEW drops, so it reports 0 — the one drop was acknowledged
    // by the first batch and is never re-sent. A running total would have said [1, 1].
    expect(transport.dropReports).toStrictEqual([1, 0]);
    expect(client.stats().droppedTooLarge).toBe(1);

    // S1 (Reviewer, ASYNC-5 [MUST]). Two DIFFERENT batches — as opposed to two retries of
    // one batch, `RetryingTransport`'s test above — must carry two DIFFERENT `deliveryId`s,
    // or the server's replay guard would treat the second batch as a replay of the first and
    // silently refuse to credit its own (zero) drop report.
    expect(transport.deliveryIds).toHaveLength(2);
    expect(transport.deliveryIds[0]).toBeDefined();
    expect(transport.deliveryIds[1]).toBeDefined();
    expect(transport.deliveryIds[0]).not.toBe(transport.deliveryIds[1]);
  });

  it('reuses one snapshot across every retry, even as new drops pile up between them', async () => {
    const scheduler = new FakeScheduler();
    let step: StepHandle | null = null;
    // One further drop during each of the three attempts, caused from inside the transport
    // — i.e. genuinely between the attempts of a single batch.
    const transport = new RetryingTransport(() => {
      if (step !== null) dropOne(step);
    });
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      maxRetries: 2,
    });

    step = stepOf(client);
    dropOne(step);
    dropOne(step);
    const flushed = client.flush();
    await scheduler.advance(600_000);
    await flushed;

    // Three attempts, ONE snapshot: 2. Re-reading the pending count per attempt would have
    // sent [2, 3, 4] — the last of which the far end could then acknowledge as if the two
    // earlier attempts had never carried anything.
    expect(transport.attempts).toBe(3);
    expect(transport.dropReports).toStrictEqual([2, 2, 2]);
    expect(client.stats()).toMatchObject({ droppedTooLarge: 5, droppedUndeliverable: 2 });

    // S1 (Reviewer, ASYNC-5 [MUST], Phase 4 phase gate repair attempt 1). Same rule as the
    // drop snapshot: `deliveryId` is minted once per batch, not once per attempt — three
    // retries of the SAME batch must carry the SAME id, or the server has no way to tell a
    // lost-response retry from a genuinely new batch and double-credits the amount above.
    expect(transport.deliveryIds).toHaveLength(3);
    expect(new Set(transport.deliveryIds).size).toBe(1);
    expect(transport.deliveryIds[0]).toBeDefined();
  });

  it('makes a delta, not a running total, of the drops a retried batch never delivered', async () => {
    const scheduler = new FakeScheduler();
    const transport = new FailingTransport(RETRYABLE);
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      maxRetries: 1,
    });

    const step = stepOf(client);
    dropOne(step);
    const flushed = client.flush();
    await scheduler.advance(600_000);
    await flushed;

    // Both attempts carried the same 1, and neither was acknowledged.
    expect(transport.dropReports).toStrictEqual([1, 1]);
    expect(client.stats()).toMatchObject({ droppedTooLarge: 1, droppedUndeliverable: 2 });
  });

  it('does not clear the count on a failed attempt — a later batch still carries it', async () => {
    const scheduler = new FakeScheduler();
    // Batch 1 is permanently refused (one attempt, no retry); batch 2 is delivered.
    const transport = new ScriptedTransport([PERMANENT]);
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      maxRetries: 0,
    });

    const step = stepOf(client); // 2 events queued
    dropOne(step);
    dropOne(step);
    const first = client.flush();
    await scheduler.advance(600_000);
    await first;

    step.complete();
    await client.flush();

    // 2 too-large + the 2 events of the batch that was given up on. Nothing was
    // acknowledged by the refused batch, so all four are still owed.
    expect(client.stats()).toMatchObject({ droppedTooLarge: 2, droppedUndeliverable: 2 });
    expect(transport.dropReports).toStrictEqual([2, 4]);

    // Reviewer B3 / Tester F2 (Phase 4 phase gate repair attempt 2). Batch 1 was ABANDONED,
    // not merely retried within itself — `deliverBatch` gave up on it after one permanently
    // refused attempt, so its drop snapshot is still pending. Batch 2 must carry the SAME
    // `deliveryId` batch 1 used, or the server has no way to tell "batch 1 actually
    // committed server-side and its response was merely lost" from "a brand new report",
    // and would credit both — the real reproduction measured 9 stored for 6 actually
    // dropped. Two DIFFERENT batches carrying the SAME id looks like the exact defect S1's
    // ledger exists to prevent; it is not, because the id identifies a still-pending
    // SNAPSHOT, not "one delivery attempt" — see `pendingDeliveryId` on `Client`.
    expect(transport.deliveryIds).toHaveLength(2);
    expect(transport.deliveryIds[0]).toBeDefined();
    expect(transport.deliveryIds[1]).toBe(transport.deliveryIds[0]);
  });

  it('mints a fresh deliveryId after a delivered batch, even though the one before it was abandoned', async () => {
    const scheduler = new FakeScheduler();
    // Batch 1 is abandoned (permanent refusal). Batches 2 and 3 both deliver — `ScriptedTransport`
    // defaults to `delivered` once its scripted outcomes run out.
    const transport = new ScriptedTransport([PERMANENT]);
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      maxRetries: 0,
    });

    const step = stepOf(client); // batch 1: run.started + step.started
    dropOne(step);
    const first = client.flush();
    await scheduler.advance(600_000);
    await first; // batch 1 abandoned

    step.complete(); // batch 2: delivered, carrying batch 1's reused id
    await client.flush();

    stepOf(client); // batch 3: a fresh run + step, no new drops
    await client.flush();

    expect(transport.deliveryIds).toHaveLength(3);
    expect(transport.deliveryIds[1]).toBe(transport.deliveryIds[0]); // reused across the abandonment
    expect(transport.deliveryIds[2]).not.toBe(transport.deliveryIds[1]); // fresh after a delivered batch
  });

  it('preserves drops that happen while a delivery is in flight', async () => {
    const scheduler = new FakeScheduler();
    const transport = new GatedTransport();
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      maxBatchSize: 4,
      maxQueueSize: 4,
      flushIntervalMs: 60_000,
      requestTimeoutMs: 60_000,
    });

    // Four events fill a batch and go in flight, where the gate holds them.
    const run = client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    for (let i = 0; i < 3; i += 1) {
      run.startStep({ name: `held-${i}`, agentName: 'a', type: 'execute' });
    }
    expect(transport.pending).toBe(1);

    // Ten more with the transport still blocked: four fit, six of the oldest are dropped.
    for (let i = 0; i < 10; i += 1) {
      run.startStep({ name: `overflow-${i}`, agentName: 'a', type: 'execute' });
    }
    expect(client.stats()).toMatchObject({ queued: 4, droppedOverflow: 6 });

    transport.releaseAll();
    await settle();

    // The pump has taken the next batch and it is now the one being held.
    expect(transport.pending).toBe(1);
    transport.releaseAll();
    await client.flush();

    // The in-flight batch was snapshotted before those six existed, so it reported 0 and
    // acknowledged 0; the next batch owes all six.
    expect(transport.dropReports).toStrictEqual([0, 6]);
  });
});
