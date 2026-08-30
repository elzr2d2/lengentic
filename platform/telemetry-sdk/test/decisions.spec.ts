import { describe, expect, it } from 'vitest';

import { REDACTED, createTelemetryClient } from '../src/index';
import { FakeScheduler } from './support/fake-scheduler';
import { RecordingTransport } from './support/test-transports';
import { wireContractViolations } from './support/wire-contract';

/**
 * Seam under test: `createTelemetryClient` (the public entry) observed through the INJECTED
 * transport — what the SDK actually put on the wire. Nothing reaches inside the client, and
 * the expected values come from §13/§14 and from `@lengentic/shared`'s schemas, which are a
 * different package owned by a different packet (TEST-4).
 */
const fixedClock = { now: () => new Date('2026-08-31T10:00:00.000Z') };

function harness() {
  const scheduler = new FakeScheduler();
  const transport = new RecordingTransport();
  const client = createTelemetryClient({ transport, scheduler, clock: fixedClock });
  return { scheduler, transport, client };
}

function step(client: ReturnType<typeof harness>['client']) {
  const run = client.startRun({ workflowName: 'demo-workflow', workflowVersion: 'a1b2c3d' });
  return run.startStep({ name: 'execute', agentName: 'demo-agent', type: 'execute' });
}

const strategyInput = {
  decisionType: 'execution_strategy',
  contextKey: 'risk=low;tasks=2-3;deps=resolved;conflict=absent;validation=ready',
  contextKeyVersion: 'v1',
  availableOptions: ['sequential', 'parallel'],
  selectedOption: 'sequential',
} as const;

function eventsOfType(transport: RecordingTransport, type: string) {
  return transport.allEvents.filter((event) => event.type === type);
}

describe('recordDecision', () => {
  it('returns a handle whose decisionId is the entityId of the event it emitted', async () => {
    const { transport, client } = harness();

    const decision = step(client).recordDecision(strategyInput);
    await client.flush();

    const recorded = eventsOfType(transport, 'decision.recorded');
    expect(recorded.length).toBe(1);
    expect(decision.decisionId).toBe(recorded[0]?.entityId);
    expect(decision.decisionId).not.toBe('');
  });

  it('correlates the decision to its step and run by client-generated id (§14)', async () => {
    const { transport, client } = harness();

    const parent = step(client);
    const decision = parent.recordDecision(strategyInput);
    await client.flush();

    const [recorded] = eventsOfType(transport, 'decision.recorded');
    expect(decision.runId).toBe(parent.runId);
    expect(decision.stepId).toBe(parent.stepId);
    expect(recorded?.runId).toBe(parent.runId);
    expect(recorded?.payload).toMatchObject({ stepId: parent.stepId });
  });

  it('puts §13 fields on the wire and nothing the contract rejects', async () => {
    const { transport, client } = harness();

    const parent = step(client);
    parent.recordDecision({ ...strategyInput, rawContext: { taskCount: 3 } });
    await client.flush();

    const [recorded] = eventsOfType(transport, 'decision.recorded');
    expect(recorded === undefined ? ['no event'] : wireContractViolations(recorded)).toStrictEqual(
      [],
    );
    expect(recorded?.type).toBe('decision.recorded');
    expect(recorded?.payload).toStrictEqual({
      stepId: parent.stepId,
      decisionType: 'execution_strategy',
      contextKey: strategyInput.contextKey,
      contextKeyVersion: 'v1',
      rawContext: { taskCount: 3 },
      availableOptions: ['sequential', 'parallel'],
      selectedOption: 'sequential',
    });
  });

  it('omits contextKey entirely when the caller supplies none — never a default (§14)', async () => {
    const { transport, client } = harness();

    step(client).recordDecision({
      decisionType: 'execution_strategy',
      availableOptions: ['sequential', 'parallel'],
      selectedOption: 'parallel',
    });
    await client.flush();

    const [recorded] = eventsOfType(transport, 'decision.recorded');
    const payload = recorded?.payload as Record<string, unknown>;
    expect(Object.keys(payload)).not.toContain('contextKey');
    expect(Object.keys(payload)).not.toContain('contextKeyVersion');
    expect(recorded === undefined ? ['no event'] : wireContractViolations(recorded)).toStrictEqual(
      [],
    );
  });

  it('runs rawContext through the §15 pipeline before it can enter the buffer', async () => {
    const { transport, client } = harness();

    step(client).recordDecision({
      ...strategyInput,
      rawContext: { apiKey: 'sk-live-abcdef', taskCount: 3 },
    });
    await client.flush();

    const [recorded] = eventsOfType(transport, 'decision.recorded');
    expect(recorded?.payload).toMatchObject({
      rawContext: { apiKey: REDACTED, taskCount: 3 },
    });
    expect(JSON.stringify(transport.allEvents)).not.toContain('sk-live-abcdef');
  });

  it('does not throw into host code when rawContext is circular (§16)', async () => {
    const { transport, client } = harness();

    const circular: Record<string, unknown> = { taskCount: 3 };
    circular['self'] = circular;

    expect(() =>
      step(client).recordDecision({ ...strategyInput, rawContext: circular }),
    ).not.toThrow();
    await client.flush();

    const [recorded] = eventsOfType(transport, 'decision.recorded');
    expect(recorded === undefined ? ['no event'] : wireContractViolations(recorded)).toStrictEqual(
      [],
    );
    expect(client.stats().droppedInvalid).toBe(0);
  });

  it('records no attestation until one is made — UNKNOWN is a state, not an event', async () => {
    const { transport, client } = harness();

    step(client).recordDecision(strategyInput);
    await client.flush();

    expect(eventsOfType(transport, 'decision.outcome_attested')).toStrictEqual([]);
  });
});

describe('attestOutcome', () => {
  it('emits an independent event keyed on the decisionId (§14)', async () => {
    const { transport, client } = harness();

    const decision = step(client).recordDecision(strategyInput);
    decision.attestOutcome('SUCCESS');
    await client.flush();

    const [attested] = eventsOfType(transport, 'decision.outcome_attested');
    expect(attested?.entityId).toBe(decision.decisionId);
    expect(attested?.runId).toBe(decision.runId);
    expect(attested?.payload).toStrictEqual({ outcome: 'SUCCESS' });
    expect(attested === undefined ? ['no event'] : wireContractViolations(attested)).toStrictEqual(
      [],
    );
  });

  it('carries observedAt when the caller knows when the outcome happened', async () => {
    const { transport, client } = harness();

    const decision = step(client).recordDecision(strategyInput);
    decision.attestOutcome('FAILURE', { observedAt: new Date('2026-08-31T12:34:56.000Z') });
    await client.flush();

    const [attested] = eventsOfType(transport, 'decision.outcome_attested');
    expect(attested?.payload).toStrictEqual({
      outcome: 'FAILURE',
      observedAt: '2026-08-31T12:34:56.000Z',
    });
  });

  it('re-attesting the same decision emits again — last write wins, not a dropped duplicate', async () => {
    const { transport, client } = harness();

    const decision = step(client).recordDecision(strategyInput);
    decision.attestOutcome('SUCCESS');
    decision.attestOutcome('FAILURE');
    await client.flush();

    const attested = eventsOfType(transport, 'decision.outcome_attested');
    expect(attested.map((event) => (event.payload as { outcome: string }).outcome)).toStrictEqual([
      'SUCCESS',
      'FAILURE',
    ]);
    expect(new Set(attested.map((event) => event.entityId)).size).toBe(1);
    expect(new Set(attested.map((event) => event.eventId)).size).toBe(2);
  });

  it("attests from a client that never saw the run — §14's 'any process, hours later'", async () => {
    const first = harness();
    const decision = step(first.client).recordDecision(strategyInput);
    await first.client.flush();

    const later = harness();
    later.client.attestOutcome(decision.decisionId, 'SUCCESS', {
      runId: decision.runId,
      observedAt: new Date('2026-08-31T18:00:00.000Z'),
    });
    await later.client.flush();

    const [attested] = eventsOfType(later.transport, 'decision.outcome_attested');
    expect(attested?.entityId).toBe(decision.decisionId);
    expect(attested?.runId).toBe(decision.runId);
    expect(attested?.payload).toStrictEqual({
      outcome: 'SUCCESS',
      observedAt: '2026-08-31T18:00:00.000Z',
    });
    expect(eventsOfType(later.transport, 'decision.recorded')).toStrictEqual([]);
  });
});
