import { describe, expect, it } from 'vitest';

import { createTelemetryClient } from '../src/index';
import { FakeScheduler } from './support/fake-scheduler';
import { RecordingTransport } from './support/test-transports';
import { wireContractViolations } from './support/wire-contract';

/**
 * Seams under test: `createTelemetryClient` (the public entry) observed through the
 * INJECTED transport — what the SDK put on the wire — and through `stats()`. Nothing
 * reaches inside the client.
 *
 * Expected values come from §16 ("Flush on interval (default 1s) or buffer size (default
 * 100), whichever comes first") and from the wire contract in `@lengentic/shared`.
 */
const fixedClock = { now: () => new Date('2026-08-21T10:00:00.000Z') };

function harness(overrides: { maxBatchSize?: number } = {}) {
  const scheduler = new FakeScheduler();
  const transport = new RecordingTransport();
  const client = createTelemetryClient({
    transport,
    scheduler,
    clock: fixedClock,
    ...(overrides.maxBatchSize === undefined ? {} : { maxBatchSize: overrides.maxBatchSize }),
  });
  return { scheduler, transport, client };
}

describe('recording and batching', () => {
  it('does not touch the transport while the caller is still working', async () => {
    const { scheduler, transport, client } = harness();

    const run = client.startRun({ workflowName: 'demo-workflow', workflowVersion: 'a1b2c3d' });
    run.startStep({ name: 'execute', agentName: 'demo-agent', type: 'execute' });

    expect(transport.batches).toStrictEqual([]);
    await scheduler.advance(999);
    expect(transport.batches).toStrictEqual([]);
  });

  it('flushes on the 1s interval §16 states', async () => {
    const { scheduler, transport, client } = harness();

    client.startRun({ workflowName: 'demo-workflow', workflowVersion: 'a1b2c3d' });
    await scheduler.advance(1_000);

    expect(transport.batches.length).toBe(1);
    expect(transport.allEvents.length).toBe(1);
  });

  it('flushes on buffer size before the interval, whichever comes first', async () => {
    const { scheduler, transport, client } = harness({ maxBatchSize: 2 });

    const run = client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    run.startStep({ name: 'execute', agentName: 'demo-agent', type: 'execute' });
    await scheduler.advance(0);

    expect(transport.allEvents.length).toBe(2);
    expect(scheduler.now).toBe(0);
  });

  it('splits a backlog into batches of at most maxBatchSize', async () => {
    const { transport, client } = harness({ maxBatchSize: 2 });

    const run = client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    for (let i = 0; i < 4; i += 1) {
      run.startStep({ name: `step-${i}`, agentName: 'demo-agent', type: 'execute' });
    }
    await client.flush();

    expect(transport.batches.map((batch) => batch.length)).toStrictEqual([2, 2, 1]);
  });

  it('emits the §16 example run/step lifecycle as four contract-valid events', async () => {
    const { transport, client } = harness();

    const run = client.startRun({ workflowName: 'demo-workflow', workflowVersion: 'a1b2c3d' });
    const step = run.startStep({ name: 'execute', agentName: 'demo-agent', type: 'execute' });
    step.complete();
    run.complete();
    await client.flush();

    const events = transport.allEvents;
    expect(events.flatMap(wireContractViolations)).toStrictEqual([]);
    expect(events.map((event) => event.type)).toStrictEqual([
      'run.started',
      'step.started',
      'step.completed',
      'run.completed',
    ]);
    expect(events.map((event) => event.runId)).toStrictEqual(Array<string>(4).fill(run.runId));
    expect(events.map((event) => event.occurredAt)).toStrictEqual(
      Array<string>(4).fill('2026-08-21T10:00:00.000Z'),
    );
  });

  it('gives start and completion different eventIds and the same entityId (§12)', async () => {
    const { transport, client } = harness();

    const run = client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    run.complete();
    await client.flush();

    const [started, completed] = transport.allEvents;
    expect(started?.entityId).toBe(run.runId);
    expect(completed?.entityId).toBe(run.runId);
    expect(started?.eventId === completed?.eventId).toBe(false);
  });

  it('resolves step hierarchy structurally — a nested step carries its parent, a top-level step carries null', async () => {
    const { transport, client } = harness();

    const run = client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    const parent = run.startStep({ name: 'parent', agentName: 'a', type: 'execute' });
    const child = parent.startStep({ name: 'child', agentName: 'a', type: 'execute' });
    await client.flush();

    const starts = transport.allEvents.filter((event) => event.type === 'step.started');
    expect(starts.map((event) => event.entityId)).toStrictEqual([parent.stepId, child.stepId]);
    expect(
      starts.map((event) => (event.payload as { parentStepId: string | null }).parentStepId),
    ).toStrictEqual([null, parent.stepId]);
  });

  it('defaults a completion to COMPLETED and carries FAILED through when asked', async () => {
    const { transport, client } = harness();

    const run = client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    const step = run.startStep({ name: 's', agentName: 'a', type: 'execute' });
    step.complete({ status: 'FAILED' });
    run.complete();
    await client.flush();

    const completions = transport.allEvents.filter((event) => event.type.endsWith('.completed'));
    expect(completions.map((event) => (event.payload as { status: string }).status)).toStrictEqual([
      'FAILED',
      'COMPLETED',
    ]);
  });

  it('counts what it recorded and what it delivered', async () => {
    const { client } = harness();

    const run = client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    run.complete();
    await client.flush();

    expect(client.stats()).toMatchObject({ recorded: 2, delivered: 2, queued: 0 });
  });
});
