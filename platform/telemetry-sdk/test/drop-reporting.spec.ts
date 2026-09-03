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

  attempts = 0;

  constructor(private readonly betweenAttempts: () => void) {}

  send(
    _events: readonly TelemetryEventEnvelope[],
    options: { readonly droppedSinceLastBatch?: number | undefined },
  ): Promise<TransportResult> {
    this.attempts += 1;
    this.dropReports.push(options.droppedSinceLastBatch);
    this.betweenAttempts();
    return Promise.resolve(RETRYABLE);
  }
}

/** Hands out a scripted result per attempt, and records the snapshot each one carried. */
class ScriptedTransport implements TelemetryTransport {
  readonly dropReports: Array<number | undefined> = [];

  constructor(private readonly results: TransportResult[]) {}

  send(
    _events: readonly TelemetryEventEnvelope[],
    options: { readonly droppedSinceLastBatch?: number | undefined },
  ): Promise<TransportResult> {
    this.dropReports.push(options.droppedSinceLastBatch);
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
