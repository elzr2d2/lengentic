import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTelemetryClient, type TelemetryDiagnostic } from '../src/index';
import { FakeScheduler, settle } from './support/fake-scheduler';
import {
  FailingTransport,
  GatedTransport,
  HangingTransport,
  RecordingTransport,
  ThrowingTransport,
} from './support/test-transports';

/**
 * Seams under test: the public client, observed through the INJECTED transport (attempt
 * counts), the INJECTED diagnostic sink (what the SDK reported instead of throwing), and
 * `stats()`. The injected scheduler makes every bound observable without a real wait.
 *
 * Expected values come from §16's own words — "Silent: the SDK NEVER throws into host
 * code", "Bounded ... drop oldest and increment a dropped counter", "Retry count is
 * configurable and FINITE" — and from arithmetic on the config the test set, never from a
 * value read back out of the client.
 */
const RETRYABLE = { outcome: 'retryable', detail: 'connection refused' } as const;
const PERMANENT = { outcome: 'permanent', detail: 'HTTP 400' } as const;

const fixedClock = { now: () => new Date('2026-08-21T10:00:00.000Z') };

/**
 * §16's silence guarantee is only real if nothing escapes as an unhandled rejection either
 * — a floating rejection kills a Node process just as dead as a throw.
 */
const unhandled: unknown[] = [];
const captureUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', captureUnhandled);
});

afterEach(async () => {
  await settle();
  process.off('unhandledRejection', captureUnhandled);
  expect(unhandled).toStrictEqual([]);
});

describe('the API being down', () => {
  it('never throws out of record, flush or shutdown, and counts the loss instead', async () => {
    const scheduler = new FakeScheduler();
    const transport = new FailingTransport(RETRYABLE);
    const diagnostics: TelemetryDiagnostic[] = [];
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      maxRetries: 2,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    let callerReachedTheEnd = false;
    const run = client.startRun({ workflowName: 'demo-workflow', workflowVersion: 'a1b2c3d' });
    run.startStep({ name: 'execute', agentName: 'demo-agent', type: 'execute' }).complete();
    run.complete();

    const flushed = client.flush();
    await scheduler.advance(60_000);
    await flushed;
    callerReachedTheEnd = true;

    expect(callerReachedTheEnd).toBe(true);
    expect(client.stats()).toMatchObject({ recorded: 4, delivered: 0, droppedUndeliverable: 4 });
    expect(diagnostics.filter((d) => d.code === 'batch_dropped').length).toBe(1);
  });

  it('treats a transport that throws synchronously as a failed attempt, not a crash', async () => {
    const scheduler = new FakeScheduler();
    const transport = new ThrowingTransport();
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      maxRetries: 1,
    });

    client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    const flushed = client.flush();
    await scheduler.advance(60_000);
    await flushed;

    expect(transport.attempts).toBe(2);
    expect(client.stats().droppedUndeliverable).toBe(1);
  });
});

describe('bounded retry', () => {
  it('makes exactly maxRetries + 1 attempts against a permanently broken endpoint', async () => {
    const scheduler = new FakeScheduler();
    const transport = new FailingTransport(RETRYABLE);
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      maxRetries: 3,
    });

    client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    const flushed = client.flush();
    await scheduler.advance(600_000);
    await flushed;

    expect(transport.attempts).toBe(4);
  });

  it('makes exactly one attempt when the retry budget is zero', async () => {
    const scheduler = new FakeScheduler();
    const transport = new FailingTransport(RETRYABLE);
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      maxRetries: 0,
    });

    client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    const flushed = client.flush();
    await scheduler.advance(600_000);
    await flushed;

    expect(transport.attempts).toBe(1);
  });

  it('does not retry a permanent rejection — the far end already refused this batch', async () => {
    const scheduler = new FakeScheduler();
    const transport = new FailingTransport(PERMANENT);
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      maxRetries: 5,
    });

    client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    const flushed = client.flush();
    await scheduler.advance(600_000);
    await flushed;

    expect(transport.attempts).toBe(1);
  });

  it('backs off exponentially, capped — 200, 400, 800 with a 800ms ceiling gives 200, 400, 800, 800', async () => {
    const scheduler = new FakeScheduler();
    const delays: number[] = [];
    let lastAttemptAt = 0;
    const transport = {
      send: (): Promise<{ outcome: 'retryable'; detail: string }> => {
        delays.push(scheduler.now - lastAttemptAt);
        lastAttemptAt = scheduler.now;
        return Promise.resolve(RETRYABLE);
      },
    };
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      maxRetries: 4,
      initialBackoffMs: 200,
      maxBackoffMs: 800,
    });

    client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    const flushed = client.flush();
    await scheduler.advance(600_000);
    await flushed;

    expect(delays).toStrictEqual([0, 200, 400, 800, 800]);
  });
});

describe('a transport that hangs', () => {
  it('bounds every attempt, aborts the request and lets the caller continue', async () => {
    const scheduler = new FakeScheduler();
    const transport = new HangingTransport();
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      maxRetries: 1,
      requestTimeoutMs: 5_000,
    });

    client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    const flushed = client.flush();
    await scheduler.advance(600_000);
    await flushed;

    expect(transport.attempts).toBe(2);
    expect(transport.abortsObserved).toBe(2);
    expect(client.stats().droppedUndeliverable).toBe(1);
  });
});

describe('the bounded buffer', () => {
  it('drops the OLDEST events on overflow, counts them, and keeps the newest', async () => {
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

    expect(client.stats()).toMatchObject({ queued: 4, droppedOverflow: 6, recorded: 14 });

    transport.releaseAll();
    await settle();
    transport.releaseAll();
    await settle();
    await client.flush();

    const survivors = transport.batches[1]?.map(
      (event) => (event.payload as { name: string }).name,
    );
    expect(survivors).toStrictEqual(['overflow-6', 'overflow-7', 'overflow-8', 'overflow-9']);
  });
});

describe('data the caller should not have been able to send', () => {
  /**
   * SUPERSEDED BY §15, 2026-08-31 (`p4.payload-safety`). Until Phase 4 this test asserted
   * that circular metadata was DROPPED — the event never reached the transport and
   * `droppedInvalid` was 1. That satisfied Phase 4's DoD line "circular data in `metadata`
   * does not throw into host code" only degenerately, by discarding the telemetry
   * (`.artifacts/evidence/4/wave-gate/probe-lie-p4.md`, appendix). §15 requires the
   * opposite: safe serialization SURVIVES a circular reference and the sanitized payload
   * still ships. The silence guarantee it was really protecting — nothing throws out of
   * `complete()` — is unchanged and still asserted.
   */
  it('sanitizes circular metadata and still ships it, without throwing out of complete()', async () => {
    const scheduler = new FakeScheduler();
    const transport = new RecordingTransport();
    const diagnostics: TelemetryDiagnostic[] = [];
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    const circular: Record<string, unknown> = { label: 'loop' };
    circular.self = circular;

    const run = client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    expect(() => run.complete({ metadata: circular })).not.toThrow();
    await client.flush();

    expect(transport.allEvents.map((event) => event.type)).toStrictEqual([
      'run.started',
      'run.completed',
    ]);
    const completed = transport.allEvents[1]?.payload as { metadata: unknown };
    expect(completed.metadata).toStrictEqual({ label: 'loop', self: '[Circular]' });
    expect(client.stats().droppedInvalid).toBe(0);
    expect(diagnostics).toStrictEqual([]);
  });

  /**
   * FIXTURE AMENDED BY §15, 2026-08-31 (`p4.payload-safety`). The rule under test is
   * unchanged — §12's 64KB per-event cap drops the event at the client rather than sending
   * a guaranteed rejection — but the old fixture (a 65KB `metadata.blob`) can no longer
   * reach it: §15's 32KB per-field cap truncates that field first, and the event now ships.
   *
   * Two capped fields on one event still exceed the per-event cap, which is where the two
   * caps genuinely fail to compose (`docs/decisions/0006`). That is the fixture now.
   */
  it('drops an event over §12s 64KB per-event cap instead of sending a guaranteed rejection', async () => {
    const scheduler = new FakeScheduler();
    const transport = new RecordingTransport();
    const client = createTelemetryClient({ transport, scheduler, clock: fixedClock });

    const step = client
      .startRun({ workflowName: 'w', workflowVersion: 'v' })
      .startStep({ name: 's', agentName: 'a', type: 'execute' });
    step.recordToolCall({
      toolName: 'read_file',
      input: 'x'.repeat(64 * 1024),
      output: 'y'.repeat(64 * 1024),
      startedAt: fixedClock.now(),
      completedAt: fixedClock.now(),
      success: true,
    });
    await client.flush();

    expect(transport.allEvents.map((event) => event.type)).toStrictEqual([
      'run.started',
      'step.started',
    ]);
    expect(client.stats()).toMatchObject({ droppedTooLarge: 1, recorded: 2 });
  });

  it('survives a diagnostic sink that throws — the reporting channel is not an escape hatch', async () => {
    const scheduler = new FakeScheduler();
    const transport = new FailingTransport(PERMANENT);
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      maxRetries: 0,
      onDiagnostic: () => {
        throw new Error('the host sink is broken');
      },
    });

    client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    const flushed = client.flush();
    await scheduler.advance(60_000);
    await flushed;

    expect(client.stats().droppedUndeliverable).toBe(1);
  });
});
