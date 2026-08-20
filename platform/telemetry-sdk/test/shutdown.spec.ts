import { describe, expect, it } from 'vitest';

import { createTelemetryClient, type TelemetryDiagnostic } from '../src/index';
import { FakeScheduler } from './support/fake-scheduler';
import { FailingTransport, HangingTransport, RecordingTransport } from './support/test-transports';

/**
 * Seams under test: `shutdown()` and `flush()` on the public client, observed through the
 * injected transport, the injected sink, `stats()`, and — for the property that matters
 * most to a short-lived script — `FakeScheduler.pendingTimerCount`, which is the in-process
 * stand-in for "is anything still holding the event loop". The process-level version of
 * that claim is proven for real in `process-exit.spec.ts`.
 *
 * Expected values come from §16 ("await telemetry.shutdown() drains the queue. Required for
 * short-lived processes and scripts") and from the configured bounds.
 */
const fixedClock = { now: () => new Date('2026-08-21T10:00:00.000Z') };

describe('shutdown', () => {
  it('drains what is queued and resolves, without waiting for the flush interval', async () => {
    const scheduler = new FakeScheduler();
    const transport = new RecordingTransport();
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      flushIntervalMs: 600_000,
    });

    const run = client.startRun({ workflowName: 'demo-workflow', workflowVersion: 'a1b2c3d' });
    run.startStep({ name: 'execute', agentName: 'demo-agent', type: 'execute' }).complete();
    run.complete();

    await client.shutdown();

    expect(transport.allEvents.length).toBe(4);
    expect(client.stats()).toMatchObject({ queued: 0, delivered: 4 });
    expect(scheduler.now).toBe(0);
  });

  it('leaves no timer behind — nothing of the SDK is still holding the loop', async () => {
    const scheduler = new FakeScheduler();
    const client = createTelemetryClient({
      transport: new RecordingTransport(),
      scheduler,
      clock: fixedClock,
    });

    client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    expect(scheduler.pendingTimerCount).toBe(1);

    await client.shutdown();

    expect(scheduler.pendingTimerCount).toBe(0);
  });

  it('is safe to call twice — the second call joins the first and sends nothing extra', async () => {
    const scheduler = new FakeScheduler();
    const transport = new RecordingTransport();
    const client = createTelemetryClient({ transport, scheduler, clock: fixedClock });

    client.startRun({ workflowName: 'w', workflowVersion: 'v' });

    const first = client.shutdown();
    const second = client.shutdown();
    await Promise.all([first, second]);
    await client.shutdown();

    expect(transport.batches.length).toBe(1);
    expect(client.stats().delivered).toBe(1);
  });

  it('drops events recorded after shutdown instead of hanging on them', async () => {
    const scheduler = new FakeScheduler();
    const transport = new RecordingTransport();
    const diagnostics: TelemetryDiagnostic[] = [];
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    await client.shutdown();

    const lateRun = client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    lateRun.startStep({ name: 'late', agentName: 'a', type: 'execute' }).complete();
    lateRun.complete();
    await client.flush();

    expect(transport.batches).toStrictEqual([]);
    expect(client.stats()).toMatchObject({ droppedAfterShutdown: 4, recorded: 0, queued: 0 });
    expect(diagnostics.every((diagnostic) => diagnostic.code === 'client_closed')).toBe(true);
    expect(scheduler.pendingTimerCount).toBe(0);
  });

  it('resolves at its own bound when the transport never answers, and says so', async () => {
    const scheduler = new FakeScheduler();
    const transport = new HangingTransport();
    const diagnostics: TelemetryDiagnostic[] = [];
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      requestTimeoutMs: 600_000,
      shutdownTimeoutMs: 5_000,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    client.startRun({ workflowName: 'w', workflowVersion: 'v' });

    let resolved = false;
    const done = client.shutdown().then(() => {
      resolved = true;
    });

    await scheduler.advance(4_999);
    expect(resolved).toBe(false);

    await scheduler.advance(1);
    await done;

    expect(resolved).toBe(true);
    expect(transport.abortsObserved).toBe(1);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('shutdown_timeout');
  });

  it('does not sit out a retry backoff longer than its own bound', async () => {
    const scheduler = new FakeScheduler();
    const transport = new FailingTransport({ outcome: 'retryable', detail: 'connection refused' });
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: fixedClock,
      maxRetries: 5,
      initialBackoffMs: 10_000,
      maxBackoffMs: 10_000,
      requestTimeoutMs: 1_000,
      shutdownTimeoutMs: 5_000,
    });

    client.startRun({ workflowName: 'w', workflowVersion: 'v' });

    let resolved = false;
    const done = client.shutdown().then(() => {
      resolved = true;
    });

    await scheduler.advance(4_999);
    expect(resolved).toBe(false);

    await scheduler.advance(1);
    await done;

    expect(resolved).toBe(true);
    expect(transport.attempts).toBe(1);
  });
});
