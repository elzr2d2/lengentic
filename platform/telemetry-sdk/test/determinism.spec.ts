import { describe, expect, it } from 'vitest';

import { createTelemetryClient, SeededClock, SeededIdGenerator } from '../src/index';
import { FakeScheduler } from './support/fake-scheduler';
import { RecordingTransport } from './support/test-transports';

/**
 * §17, end to end: "the same scenario seed must generate identical IDs, timestamps,
 * decisions, and payloads." A client built from the same seed twice, driven through the
 * same calls, must emit byte-identical envelopes — this is what makes a diff of two
 * scenario runs meaningful (§17's stated purpose). Unit-level coverage of the two seams
 * lives in `injection.spec.ts`; this test proves the client actually wires them in rather
 * than keeping its own `newId()`/`Date.now()` path alongside them.
 */
async function runScenario(seed: number): Promise<{ readonly transport: RecordingTransport }> {
  const transport = new RecordingTransport();
  const client = createTelemetryClient({
    transport,
    scheduler: new FakeScheduler(),
    clock: new SeededClock(seed),
    idGenerator: new SeededIdGenerator(seed),
  });

  const run = client.startRun({ workflowName: 'demo-workflow', workflowVersion: 'v1' });
  const step = run.startStep({ name: 'execute', agentName: 'demo-agent', type: 'execute' });
  step.complete();
  run.complete();

  await client.flush();

  return { transport };
}

describe('same-seed determinism', () => {
  it('emits byte-identical envelopes from two separately constructed clients', async () => {
    const first = await runScenario(1_234);
    const second = await runScenario(1_234);

    expect(first.transport.allEvents.length).toBeGreaterThan(0);
    expect(second.transport.allEvents).toEqual(first.transport.allEvents);
    // toEqual alone would also pass two empty arrays; pin the shape too.
    expect(JSON.stringify(second.transport.allEvents)).toBe(
      JSON.stringify(first.transport.allEvents),
    );
  });

  it('emits different ids and timestamps from a different seed', async () => {
    const first = await runScenario(1_234);
    const second = await runScenario(5_678);

    const firstIds = first.transport.allEvents.map((event) => event.eventId);
    const secondIds = second.transport.allEvents.map((event) => event.eventId);
    expect(secondIds).not.toEqual(firstIds);

    const firstTimes = first.transport.allEvents.map((event) => event.occurredAt);
    const secondTimes = second.transport.allEvents.map((event) => event.occurredAt);
    expect(secondTimes).not.toEqual(firstTimes);
  });
});
