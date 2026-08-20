import { describe, expect, it } from 'vitest';

import {
  createTelemetryClient,
  TELEMETRY_DEFAULTS,
  TelemetryConfigError,
  type TelemetryConfig,
} from '../src/index';
import { FakeScheduler } from './support/fake-scheduler';
import { GatedTransport, RecordingTransport } from './support/test-transports';

/**
 * Seam: `createTelemetryClient`'s config argument. §16 licenses exactly one throw —
 * "Invalid SDK initialization config MAY fail fast with a clear error. That is a
 * programming error at startup, not a runtime telemetry event." These tests pin both
 * halves: startup throws, and nothing else ever does.
 *
 * The default literals are read from §16 ("interval (default 1s) or buffer size (default
 * 100)") and from §12's `INGEST_LIMITS`, not from the module under test.
 */
const stub = { transport: new RecordingTransport() };

const rejected: ReadonlyArray<[string, TelemetryConfig]> = [
  ['neither endpoint nor transport', {}],
  ['an endpoint that is not a URL', { endpoint: 'localhost:3000' }],
  ['a non-http endpoint', { endpoint: 'ftp://example.com' }],
  ['an empty endpoint', { endpoint: '' }],
  ['a fractional flush interval', { ...stub, flushIntervalMs: 1.5 }],
  ['a zero flush interval', { ...stub, flushIntervalMs: 0 }],
  ['a batch over §12s 500-event limit', { ...stub, maxBatchSize: 501 }],
  ['a zero batch size', { ...stub, maxBatchSize: 0 }],
  ['a queue smaller than a batch', { ...stub, maxBatchSize: 100, maxQueueSize: 50 }],
  ['a negative retry budget', { ...stub, maxRetries: -1 }],
  ['a fractional retry budget', { ...stub, maxRetries: 2.5 }],
  ['an infinite retry budget', { ...stub, maxRetries: Number.POSITIVE_INFINITY }],
  ['a retry budget indistinguishable from unbounded', { ...stub, maxRetries: 1_000_000 }],
  ['a backoff ceiling below the floor', { ...stub, initialBackoffMs: 500, maxBackoffMs: 100 }],
  ['a zero request timeout', { ...stub, requestTimeoutMs: 0 }],
  ['a zero shutdown timeout', { ...stub, shutdownTimeoutMs: 0 }],
];

describe('initialization config', () => {
  it.each(rejected)('fails fast on %s', (_label, config) => {
    expect(() => createTelemetryClient(config)).toThrow(TelemetryConfigError);
  });

  it('carries §16s stated defaults', () => {
    expect(TELEMETRY_DEFAULTS.flushIntervalMs).toBe(1_000);
    expect(TELEMETRY_DEFAULTS.maxBatchSize).toBe(100);
  });

  it('accepts an endpoint alone and builds its own HTTP transport', () => {
    expect(() => createTelemetryClient({ endpoint: 'http://127.0.0.1:3000' })).not.toThrow();
  });
});

describe('holding the host process open', () => {
  it('asks for no keep-alive during ordinary background work', () => {
    const scheduler = new FakeScheduler();
    const client = createTelemetryClient({
      transport: new RecordingTransport(),
      scheduler,
      clock: { now: () => new Date('2026-08-21T10:00:00.000Z') },
    });

    client.startRun({ workflowName: 'w', workflowVersion: 'v' });

    expect(scheduler.pendingTimerCount).toBe(1);
    expect(scheduler.keepAliveTimerCount).toBe(0);
  });

  it('asks for keep-alive while shutdown() is draining, so the drain is not cut short', async () => {
    const scheduler = new FakeScheduler();
    const transport = new GatedTransport();
    const client = createTelemetryClient({
      transport,
      scheduler,
      clock: { now: () => new Date('2026-08-21T10:00:00.000Z') },
      flushIntervalMs: 60_000,
      requestTimeoutMs: 30_000,
      shutdownTimeoutMs: 30_000,
    });

    client.startRun({ workflowName: 'w', workflowVersion: 'v' });

    const done = client.shutdown();
    await new Promise<void>((settled) => setImmediate(settled));

    // The shutdown deadline and the in-flight attempt's timeout, both refusing to let the
    // runtime declare the process idle while events are still undelivered.
    expect(scheduler.keepAliveTimerCount).toBe(2);

    transport.releaseAll();
    await done;

    expect(scheduler.pendingTimerCount).toBe(0);
    expect(client.stats().delivered).toBe(1);
  });
});
