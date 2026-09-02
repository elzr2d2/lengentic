import { describe, expect, it } from 'vitest';

import {
  createTelemetryClient,
  REDACTED,
  type TelemetryConfig,
  type TelemetryDiagnostic,
} from '../src/index';
import { FakeScheduler } from './support/fake-scheduler';
import { RecordingTransport } from './support/test-transports';
import { wireContractViolations } from './support/wire-contract';

/**
 * Seam: `createTelemetryClient` (the public entry) observed through the INJECTED transport
 * — what the SDK actually put on the wire. The same seam `payload-safety-wire.spec.ts`
 * uses, for the same reason: `before transmission` is a claim about the bytes that left the
 * process, and the transport is where those bytes are.
 *
 * These cases bind the two halves of the Phase 4 Definition-of-Done preamble
 * (`MVP_PLAN_V3.md:1802-1805`) that had no producer at all before this packet — "which
 * models ... were called" and "where failures occurred". The SDK emitted seven of the nine
 * wire types; `model_call.recorded` and `error.recorded` were registered, routed and
 * persisted, and never emitted.
 *
 * TEST-4: the pass/fail oracle for envelope shape is `wireContractViolations`, which parses
 * with `@lengentic/shared` — a different package, owned by a different packet, and the same
 * code the API validates with. Each describe opens with the case that proves the oracle can
 * still fail, so a green below is not the oracle agreeing with itself.
 */

const occurredAt = new Date('2026-09-02T10:00:00.000Z');

function harness(overrides: Partial<TelemetryConfig> = {}) {
  const scheduler = new FakeScheduler();
  const transport = new RecordingTransport();
  const client = createTelemetryClient({
    transport,
    scheduler,
    clock: { now: () => occurredAt },
    ...overrides,
  });
  return { transport, client };
}

function stepOf(client: ReturnType<typeof harness>['client']) {
  return client
    .startRun({ workflowName: 'demo-workflow', workflowVersion: 'a1b2c3d' })
    .startStep({ name: 'execute', agentName: 'demo-agent', type: 'execute' });
}

function eventsOf(transport: RecordingTransport, type: string) {
  return transport.allEvents.filter((event) => event.type === type);
}

/** Every event the SDK emitted, serialized — the bytes a reader would have to search. */
function wireText(transport: RecordingTransport): string {
  return JSON.stringify(transport.allEvents);
}

const encoder = new TextEncoder();

function measure(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? 'null').length;
}

describe('DoD preamble: which models were called', () => {
  it('the oracle refuses a model_call payload off the contract', () => {
    // Negative first (CLAUDE.md ## Product claims). Without this, every green below could
    // be `wireContractViolations` returning `[]` for anything at all.
    const violations = wireContractViolations({
      eventId: 'e1',
      schemaVersion: '2',
      type: 'model_call.recorded',
      entityId: 'm1',
      runId: 'r1',
      occurredAt: occurredAt.toISOString(),
      // `latencyMs` negative and `status` missing — both required by
      // `platform/shared/schema/model-call-events.ts`.
      payload: { stepId: 's1', provider: 'mock', model: 'mock-v1', latencyMs: -1 },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('payload(model_call.recorded)');
  });

  it('emits one model_call.recorded carrying the caller values, on the contract', async () => {
    const { transport, client } = harness();
    const step = stepOf(client);

    const modelCallId = step.recordModelCall({
      provider: 'mock',
      model: 'mock-model-v1',
      latencyMs: 42,
      inputTokens: 11,
      outputTokens: 23,
      status: 'success',
      metadata: { temperature: 0 },
    });
    await client.shutdown();

    const events = eventsOf(transport, 'model_call.recorded');
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(wireContractViolations(event!)).toStrictEqual([]);
    // §12: the envelope's `entityId` is the id the caller was handed back.
    expect(event?.entityId).toBe(modelCallId);
    expect(event?.runId).toBe(step.runId);
    // ADR 0005 decision 3 / `event-type.ts`: the four Phase 4 types are legal from '2' on.
    expect(event?.schemaVersion).toBe('2');
    expect(event?.payload).toStrictEqual({
      stepId: step.stepId,
      provider: 'mock',
      model: 'mock-model-v1',
      latencyMs: 42,
      inputTokens: 11,
      outputTokens: 23,
      status: 'success',
      metadata: { temperature: 0 },
    });
  });

  it('leaves the two optional token counts absent rather than null when unsupplied', async () => {
    // §13 marks exactly `inputTokens`/`outputTokens` optional. `exactOptionalPropertyTypes`
    // (TS-8) and the same reasoning `recordDecision` records for `contextKey`: an absent
    // count and a count of zero are different statements about a call.
    const { transport, client } = harness();
    stepOf(client).recordModelCall({
      provider: 'mock',
      model: 'mock-model-v1',
      latencyMs: 0,
      status: 'failure',
    });
    await client.shutdown();

    const [event] = eventsOf(transport, 'model_call.recorded');
    expect(wireContractViolations(event!)).toStrictEqual([]);
    expect(Object.keys(event?.payload as object).sort()).toStrictEqual([
      'latencyMs',
      'model',
      'provider',
      'status',
      'stepId',
    ]);
  });

  it('does not throw and does not ship the event when a field is off the contract', async () => {
    // §16: "The record methods must not throw." `provider` past `NameSchema`'s 200-char
    // bound is refused at `checkEnvelope`, counted, and reported — never raised into host
    // code, and never half-shipped.
    const { transport, client } = harness();
    const step = stepOf(client);

    expect(() =>
      step.recordModelCall({
        provider: 'p'.repeat(201),
        model: 'mock-model-v1',
        latencyMs: 1,
        status: 'success',
      }),
    ).not.toThrow();
    await client.shutdown();

    expect(eventsOf(transport, 'model_call.recorded')).toStrictEqual([]);
    expect(client.stats().droppedInvalid).toBe(1);
  });

  it('rounds and floors a fractional latency rather than losing the call to it', async () => {
    // A caller measuring with `performance.now()` hands over `41.7`, which
    // `latencyMs: z.number().int()` refuses — and the whole model call would be dropped for
    // a sub-millisecond difference. Same clamp `recordToolCall` already applies to
    // `durationMs`, one layer earlier because the caller supplies this one directly.
    const { transport, client } = harness();
    stepOf(client).recordModelCall({
      provider: 'mock',
      model: 'mock-model-v1',
      latencyMs: 41.7,
      status: 'success',
    });
    stepOf(client).recordModelCall({
      provider: 'mock',
      model: 'mock-model-v1',
      latencyMs: -3,
      status: 'success',
    });
    await client.shutdown();

    const latencies = eventsOf(transport, 'model_call.recorded').map(
      (event) => (event.payload as { latencyMs: number }).latencyMs,
    );
    expect(latencies).toStrictEqual([42, 0]);
    expect(client.stats().droppedInvalid).toBe(0);
  });

  it('drops a non-finite latencyMs with a diagnostic instead of shipping NaN or Infinity', async () => {
    // handles.ts's `Number.isFinite(call.latencyMs) ? Math.max(0, Math.round(...)) : NaN`
    // guard: none of NaN, Infinity or -Infinity is "a measurement", so the honest answer is
    // drop-with-diagnostic, never a clamped substitute. Pinned per value, not as one bulk
    // case, because `Math.max(0, Math.round(x))` ALONE already lands on a schema-refusing
    // value for NaN (`NaN`) and Infinity (`Infinity`, which fails `.int()`) — this guard is
    // the ONLY thing that changes the outcome for -Infinity, from a clamped `0` (which the
    // schema accepts and would ship) to a drop. Without this case the guard could be
    // deleted and every other test here would stay green.
    for (const latencyMs of [NaN, Infinity, -Infinity]) {
      const diagnostics: TelemetryDiagnostic[] = [];
      const { transport, client } = harness({ onDiagnostic: (d) => diagnostics.push(d) });

      expect(() =>
        stepOf(client).recordModelCall({
          provider: 'mock',
          model: 'mock-model-v1',
          latencyMs,
          status: 'success',
        }),
      ).not.toThrow();
      await client.shutdown();

      expect(eventsOf(transport, 'model_call.recorded')).toStrictEqual([]);
      expect(client.stats().droppedInvalid).toBe(1);
      expect(diagnostics.some((diagnostic) => diagnostic.code === 'event_invalid')).toBe(true);
    }
  });
});

describe('DoD preamble: where failures occurred', () => {
  it('the oracle refuses an error payload off the contract', () => {
    const violations = wireContractViolations({
      eventId: 'e1',
      schemaVersion: '2',
      type: 'error.recorded',
      entityId: 'x1',
      runId: 'r1',
      occurredAt: occurredAt.toISOString(),
      // `message` missing; `type` empty, past `NameSchema`'s `.min(1)`.
      payload: { stepId: 's1', type: '' },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('payload(error.recorded)');
  });

  it('emits one error.recorded carrying the caller values, on the contract', async () => {
    const { transport, client } = harness();
    const step = stepOf(client);

    const errorId = step.recordError({
      type: 'MockProviderFailure',
      message: 'simulated failure at step "plan"',
      metadata: { retryable: false },
    });
    await client.shutdown();

    const events = eventsOf(transport, 'error.recorded');
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(wireContractViolations(event!)).toStrictEqual([]);
    expect(event?.entityId).toBe(errorId);
    expect(event?.runId).toBe(step.runId);
    expect(event?.schemaVersion).toBe('2');
    expect(event?.payload).toStrictEqual({
      stepId: step.stepId,
      type: 'MockProviderFailure',
      message: 'simulated failure at step "plan"',
      metadata: { retryable: false },
    });
  });

  it('keeps an empty message rather than refusing the event', async () => {
    // `error-events.ts`: "an empty message is uninformative but it is not malformed, and
    // rejecting the event would discard the `type` and `stepId` that still locate the
    // failure." The emitter must not add a `.min(1)` the wire contract declined to add.
    const { transport, client } = harness();
    stepOf(client).recordError({ type: 'EmptyError', message: '' });
    await client.shutdown();

    const [event] = eventsOf(transport, 'error.recorded');
    expect(wireContractViolations(event!)).toStrictEqual([]);
    expect((event?.payload as { message: string }).message).toBe('');
  });
});

describe('DoD line 1 extended: §15 payload safety covers the two new payloads', () => {
  it('never puts a credential-shaped error message or metadata field on the wire', async () => {
    const { transport, client } = harness();
    const step = stepOf(client);
    step.recordError({
      type: 'AuthError',
      message: 'Bearer sk-live-FAKE-8888-9999',
      metadata: {
        apiKey: 'sk-live-FAKE-1010',
        headers: { Authorization: 'Bearer sk-live-FAKE-1111' },
        endpoint: 'https://api.example.com/v1/chat',
      },
    });
    await client.shutdown();

    const wire = wireText(transport);
    expect(wire).not.toContain('sk-live-FAKE-8888-9999');
    expect(wire).not.toContain('sk-live-FAKE-1010');
    expect(wire).not.toContain('sk-live-FAKE-1111');

    const [event] = eventsOf(transport, 'error.recorded');
    expect(event?.payload).toStrictEqual({
      stepId: step.stepId,
      type: 'AuthError',
      message: REDACTED,
      metadata: {
        apiKey: REDACTED,
        headers: { Authorization: REDACTED },
        endpoint: 'https://api.example.com/v1/chat',
      },
    });
    // Redaction is not deletion: the failure is still locatable.
    expect(wire).toContain('AuthError');
  });

  it('applies the same defaults to model call metadata', async () => {
    const { transport, client } = harness();
    stepOf(client).recordModelCall({
      provider: 'mock',
      model: 'mock-model-v1',
      latencyMs: 5,
      status: 'success',
      metadata: { apiKey: 'sk-live-FAKE-2020', region: 'eu-west-1' },
    });
    await client.shutdown();

    const wire = wireText(transport);
    expect(wire).not.toContain('sk-live-FAKE-2020');
    const [event] = eventsOf(transport, 'model_call.recorded');
    expect((event?.payload as { metadata: unknown }).metadata).toStrictEqual({
      apiKey: REDACTED,
      region: 'eu-west-1',
    });
  });

  it('offers the error message to the caller redact hook at path "message"', async () => {
    // §15's shipped defaults are KEY-shaped (`Authorization`, `/api[_-]?key/i`) plus one
    // value rule (a string that IS a bearer token). An `error.message` is free prose with
    // no key to match on, so a secret embedded mid-sentence is only reachable through
    // §15's own extension point — `redact?: (value, path) => unknown`. Both halves are
    // asserted here so the boundary is recorded rather than assumed: the hook DOES reach
    // this field, and the shipped defaults alone do NOT scan prose.
    //
    // Widening `defaultRedactor` to scan every string value for embedded credentials would
    // change what ships for tool IO and metadata too — outside this packet's blast radius
    // (REFAC-3), and against `payload-safety.ts`'s own recorded argument that a false
    // positive costs a run a developer can no longer reconstruct. Filed as follow-up.
    const seenPaths: string[] = [];
    const { transport, client } = harness({
      redact: (value, path) => {
        seenPaths.push(path);
        return path === 'message' ? '[SCRUBBED]' : value;
      },
    });
    stepOf(client).recordError({
      type: 'ProviderError',
      message: 'upstream rejected the call: apiKey=sk-live-FAKE-3030 is expired',
    });
    await client.shutdown();

    expect(seenPaths).toContain('message');
    expect(wireText(transport)).not.toContain('sk-live-FAKE-3030');
    const [event] = eventsOf(transport, 'error.recorded');
    expect((event?.payload as { message: string }).message).toBe('[SCRUBBED]');
  });
});

describe('DoD line 2 extended: a 1MB error message is truncated, not dropped', () => {
  it('caps what ships at maxFieldBytes and marks the truncation in band', async () => {
    // `error-events.ts` leaves `message` unbounded to match the Prisma column. §12's
    // 64KB PER-EVENT cap does not: uncapped, the whole event — `type`, `stepId` and all —
    // is refused by `checkEnvelope` and the failure is lost outright. The §15 cap is what
    // keeps the event. `error.recorded` has no `*Truncated` flag on the wire and this
    // packet does not own `platform/shared/**`, so the marker is in band, in the string.
    const oneMegabyte = 'y'.repeat(1024 * 1024);
    const { transport, client } = harness();
    stepOf(client).recordError({ type: 'HugeError', message: oneMegabyte });
    await client.shutdown();

    const [event] = eventsOf(transport, 'error.recorded');
    expect(wireContractViolations(event!)).toStrictEqual([]);
    const message = (event?.payload as { message: string }).message;
    expect(measure(message)).toBeLessThanOrEqual(32 * 1024);
    expect(message).toMatch(/\[truncated\]$/);
    expect(message.startsWith('yyyy')).toBe(true);
    expect(client.stats().droppedTooLarge).toBe(0);
    expect(client.stats().delivered).toBe(3);
  });

  it('would have dropped the same event entirely without the cap', async () => {
    // The counterfactual, so the previous test is not a tautology — the same shape
    // `payload-safety-wire.spec.ts` uses for the 1MB tool output. With the field cap raised
    // to §12's per-event ceiling, `checkEnvelope` is what decides, and it refuses.
    const { transport, client } = harness({ maxFieldBytes: 64 * 1024 });
    stepOf(client).recordError({ type: 'HugeError', message: 'y'.repeat(1024 * 1024) });
    await client.shutdown();

    expect(eventsOf(transport, 'error.recorded')).toStrictEqual([]);
    expect(client.stats().droppedTooLarge).toBe(1);
  });
});
