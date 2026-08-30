import { describe, expect, it } from 'vitest';

import { createTelemetryClient, REDACTED, type TelemetryConfig } from '../src/index';
import { FakeScheduler } from './support/fake-scheduler';
import { RecordingTransport } from './support/test-transports';
import { wireContractViolations } from './support/wire-contract';

/**
 * Seam: `createTelemetryClient` (the public entry) observed through the INJECTED transport
 * — what the SDK actually put on the wire. Nothing reaches inside the client, and nothing
 * here calls the payload-safety module directly; `payload-safety.spec.ts` covers that unit.
 *
 * These four cases bind three lines of the Phase 4 Definition of Done
 * (`MVP_PLAN_V3.md:1804-1806`). The distinction that matters is `before transmission`: the
 * assertion is over `transport.allEvents`, so a secret that reached the transport has left
 * the process as far as this SDK is concerned, whatever a later layer does about it.
 *
 * TEST-4: the pass/fail oracle for envelope shape is `wireContractViolations`, which parses
 * with `@lengentic/shared` — a different package, owned by a different packet, and the same
 * code the API validates with. The byte expectations are measured in the test.
 */

const encoder = new TextEncoder();
const startedAt = new Date('2026-08-31T09:00:00.000Z');
const completedAt = new Date('2026-08-31T09:00:02.500Z');

function measure(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? 'null').length;
}

function harness(overrides: Partial<TelemetryConfig> = {}) {
  const scheduler = new FakeScheduler();
  const transport = new RecordingTransport();
  const client = createTelemetryClient({
    transport,
    scheduler,
    clock: { now: () => startedAt },
    ...overrides,
  });
  return { transport, client };
}

/** Every event the SDK emitted, serialized — the bytes a reader would have to search. */
function wireText(transport: RecordingTransport): string {
  return JSON.stringify(transport.allEvents);
}

function toolCallPayloads(transport: RecordingTransport): Array<Record<string, unknown>> {
  return transport.allEvents
    .filter((event) => event.type === 'tool_call.recorded')
    .map((event) => event.payload as Record<string, unknown>);
}

describe('DoD: a tool input containing a fake API key is redacted before transmission', () => {
  it('never puts the key on the wire', async () => {
    const { transport, client } = harness();
    const run = client.startRun({ workflowName: 'demo-workflow', workflowVersion: 'a1b2c3d' });
    const step = run.startStep({ name: 'search', agentName: 'demo-agent', type: 'execute' });

    step.recordToolCall({
      toolName: 'http_get',
      input: {
        url: 'https://api.example.com/v1/search',
        headers: { Authorization: 'Bearer sk-live-FAKE-0000-1111', accept: 'application/json' },
        apiKey: 'sk-live-FAKE-2222-3333',
      },
      startedAt,
      completedAt,
      success: true,
    });
    await client.shutdown();

    const wire = wireText(transport);
    expect(wire).not.toContain('sk-live-FAKE-0000-1111');
    expect(wire).not.toContain('sk-live-FAKE-2222-3333');

    const [payload] = toolCallPayloads(transport);
    expect(payload?.input).toStrictEqual({
      url: 'https://api.example.com/v1/search',
      headers: { Authorization: REDACTED, accept: 'application/json' },
      apiKey: REDACTED,
    });
    // Redaction is not deletion: the run is still reconstructable.
    expect(wire).toContain('https://api.example.com/v1/search');
  });

  it('applies the same defaults to Run and Step metadata', async () => {
    const { transport, client } = harness();
    const run = client.startRun({
      workflowName: 'demo-workflow',
      workflowVersion: 'a1b2c3d',
      metadata: { apiKey: 'sk-live-FAKE-4444' },
    });
    run
      .startStep({
        name: 'search',
        agentName: 'demo-agent',
        type: 'execute',
        metadata: { headers: { Authorization: 'Basic ZGVtbzpGQUtF' } },
      })
      .complete({ metadata: { proxy: 'Bearer FAKE-5555' } });
    await client.shutdown();

    const wire = wireText(transport);
    expect(wire).not.toContain('sk-live-FAKE-4444');
    expect(wire).not.toContain('ZGVtbzpGQUtF');
    expect(wire).not.toContain('FAKE-5555');
    // §15 applies to every arbitrary JSON field, so all three events carry the marker.
    expect(wire.split(REDACTED).length - 1).toBe(3);
  });
});

describe('DoD: a 1MB tool output is truncated and flagged', () => {
  it('caps what ships at 32KB, sets outputTruncated, and keeps the original measurement', async () => {
    const oneMegabyte = 'y'.repeat(1024 * 1024);
    const { transport, client } = harness();
    const step = client
      .startRun({ workflowName: 'demo-workflow', workflowVersion: 'a1b2c3d' })
      .startStep({ name: 'read', agentName: 'demo-agent', type: 'execute' });

    step.recordToolCall({
      toolName: 'read_file',
      input: { path: '/tmp/big.txt' },
      output: oneMegabyte,
      startedAt,
      completedAt,
      success: true,
    });
    await client.shutdown();

    const [payload] = toolCallPayloads(transport);
    expect(payload?.outputTruncated).toBe(true);
    expect(payload?.inputTruncated).toBe(false);
    // Measured here, not read back from the SDK: 1MB plus the two JSON quotes.
    expect(payload?.outputBytes).toBe(measure(oneMegabyte));
    expect(payload?.outputBytes).toBe(1024 * 1024 + 2);
    expect(measure(payload?.output)).toBeLessThanOrEqual(32 * 1024);

    // §15: "Never silently store a 4MB blob." The whole event stays inside §12's per-event
    // cap too, so it is delivered rather than dropped as `event_too_large`.
    expect(client.stats().droppedTooLarge).toBe(0);
    expect(client.stats().delivered).toBe(3);
  });

  it('would have dropped the same event entirely without the cap', async () => {
    // The counterfactual, so the previous test is not a tautology: an event carrying the
    // untruncated blob exceeds §12's 64KB per-event limit and is refused at the client.
    // Reached by raising maxFieldBytes to the ceiling — the cap is then wide enough that
    // `checkEnvelope`, not the cap, is what decides.
    const { transport, client } = harness({ maxFieldBytes: 64 * 1024 });
    const step = client
      .startRun({ workflowName: 'demo-workflow', workflowVersion: 'a1b2c3d' })
      .startStep({ name: 'read', agentName: 'demo-agent', type: 'execute' });

    step.recordToolCall({
      toolName: 'read_file',
      output: 'y'.repeat(1024 * 1024),
      startedAt,
      completedAt,
      success: true,
    });
    await client.shutdown();

    expect(toolCallPayloads(transport)).toStrictEqual([]);
    expect(client.stats().droppedTooLarge).toBe(1);
  });
});

describe('DoD: circular data in metadata does not throw into host code', () => {
  it('records, ships the sanitized payload, and drops nothing', async () => {
    const cyclic: Record<string, unknown> = { workflow: 'demo' };
    cyclic.self = cyclic;

    const { transport, client } = harness();
    expect(() =>
      client.startRun({
        workflowName: 'demo-workflow',
        workflowVersion: 'a1b2c3d',
        metadata: cyclic,
      }),
    ).not.toThrow();
    await client.shutdown();

    // The degenerate satisfaction of this DoD line is "does not throw, because the event was
    // discarded" — `transport.ts:72` classified circular data as permanently unsendable.
    // These three assertions are what separate the two readings.
    expect(client.stats().droppedInvalid).toBe(0);
    expect(client.stats().delivered).toBe(1);
    expect(transport.allEvents[0]?.payload).toStrictEqual({
      workflowName: 'demo-workflow',
      workflowVersion: 'a1b2c3d',
      metadata: { workflow: 'demo', self: '[Circular]' },
    });
  });

  it('survives BigInt, Map, Set and a throwing getter on the same field', async () => {
    const hostile: Record<string, unknown> = {
      big: 2n ** 70n,
      lookup: new Map([['a', 1]]),
      tags: new Set(['x']),
    };
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('detonated');
      },
    });

    const { transport, client } = harness();
    const step = client
      .startRun({ workflowName: 'demo-workflow', workflowVersion: 'a1b2c3d' })
      .startStep({ name: 'work', agentName: 'demo-agent', type: 'execute', metadata: hostile });
    step.complete();
    await client.shutdown();

    expect(client.stats().droppedInvalid).toBe(0);
    const started = transport.allEvents.find((event) => event.type === 'step.started');
    expect((started?.payload as { metadata: unknown }).metadata).toStrictEqual({
      big: '1180591620717411303424',
      lookup: { a: 1 },
      tags: ['x'],
      boom: '[Unreadable: detonated]',
    });
  });
});

describe('DoD support: captureToolIO: false', () => {
  it('drops input and output while keeping timing and success', async () => {
    const { transport, client } = harness({ captureToolIO: false });
    const step = client
      .startRun({ workflowName: 'demo-workflow', workflowVersion: 'a1b2c3d' })
      .startStep({ name: 'search', agentName: 'demo-agent', type: 'execute' });

    step.recordToolCall({
      toolName: 'http_get',
      input: { apiKey: 'sk-live-FAKE-6666', url: 'https://api.example.com' },
      output: { rows: [1, 2, 3] },
      startedAt,
      completedAt,
      success: false,
      error: 'HTTP 503',
    });
    await client.shutdown();

    const [payload] = toolCallPayloads(transport);
    expect(payload?.input).toBeNull();
    expect(payload?.output).toBeNull();
    // §15: "while retaining timing and success data".
    expect(payload?.durationMs).toBe(2_500);
    expect(payload?.startedAt).toBe('2026-08-31T09:00:00.000Z');
    expect(payload?.completedAt).toBe('2026-08-31T09:00:02.500Z');
    expect(payload?.success).toBe(false);
    expect(payload?.error).toBe('HTTP 503');
    // Nothing about the input survived, not even the harmless part.
    expect(wireText(transport)).not.toContain('api.example.com');
  });
});

describe('everything the pipeline emits is still on the wire contract', () => {
  it('passes the independent oracle for every event above', async () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;

    const { transport, client } = harness();
    const run = client.startRun({
      workflowName: 'demo-workflow',
      workflowVersion: 'a1b2c3d',
      metadata: cyclic,
    });
    const step = run.startStep({ name: 'search', agentName: 'demo-agent', type: 'execute' });
    step.recordToolCall({
      toolName: 'http_get',
      input: { apiKey: 'sk-live-FAKE-7777' },
      output: 'z'.repeat(200_000),
      startedAt,
      completedAt,
      success: true,
    });
    step.complete();
    run.complete();
    await client.shutdown();

    expect(transport.allEvents.length).toBe(5);
    for (const event of transport.allEvents) {
      expect(wireContractViolations(event)).toStrictEqual([]);
    }
  });

  it('rejects a per-field cap above §12s per-event cap at construction', () => {
    // A per-field cap wider than the per-event cap cannot hold: the event would be dropped
    // whole before the field cap mattered, which is a silent loss dressed as a setting.
    expect(() => harness({ maxFieldBytes: 128 * 1024 })).toThrow(/maxFieldBytes/);
    expect(() => harness({ maxFieldBytes: 16 })).toThrow(/maxFieldBytes/);
  });
});
