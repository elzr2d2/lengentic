/**
 * Uses Node's built-in test runner (`node:test`/`node:assert`) — see the note in
 * `seed.spec.ts` for why: `vitest` is not a dependency `playground/package.json` declares,
 * and adding it is outside this lane's `allowed_paths` (`.artifacts/backlog/pending.md`).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSeededPlaygroundTelemetry } from '../telemetry';
import { RecordingTransport } from './support/recording-transport';

/**
 * Seam: `createSeededPlaygroundTelemetry` → a real `TelemetryClient`, driven the same way
 * `MockAgent` will drive it (`startRun` → `startStep` → complete → complete), observed
 * through the envelopes the SDK actually hands its transport. This is the "genuinely wired
 * into the SDK" proof the packet asks for — presence of the `Seeded*` names is a crude probe;
 * byte-identical output from two independently constructed clients is the real claim
 * (`MVP_PLAN_V3.md` §17).
 */
async function runScenario(seed: number): Promise<RecordingTransport> {
  const transport = new RecordingTransport();
  const client = createSeededPlaygroundTelemetry(seed, { transport });

  const run = client.startRun({ workflowName: 'determinism-demo', workflowVersion: 'v1' });
  const step = run.startStep({ name: 'execute', agentName: 'demo-agent', type: 'execute' });
  step.complete();
  run.complete();

  await client.flush();
  return transport;
}

void describe('createSeededPlaygroundTelemetry — end-to-end wiring', () => {
  // Negative fixture first: a client that ignored its seed (e.g. fell back to the runtime
  // clock/idGenerator) must fail this before anything else is trusted.
  void it('emits different ids and timestamps for a different seed', async () => {
    const first = await runScenario(4_321);
    const second = await runScenario(9_999);

    const firstIds = first.allEvents.map((event) => event.eventId);
    const secondIds = second.allEvents.map((event) => event.eventId);
    assert.notDeepStrictEqual(secondIds, firstIds);

    const firstTimes = first.allEvents.map((event) => event.occurredAt);
    const secondTimes = second.allEvents.map((event) => event.occurredAt);
    assert.notDeepStrictEqual(secondTimes, firstTimes);
  });

  void it('emits byte-identical envelopes across two independently constructed clients with the same seed', async () => {
    const first = await runScenario(4_321);
    const second = await runScenario(4_321);

    assert.ok(first.allEvents.length > 0);
    assert.deepStrictEqual(second.allEvents, first.allEvents);
    // deepStrictEqual alone would also pass two empty arrays; pin the exact serialized
    // shape too.
    assert.strictEqual(JSON.stringify(second.allEvents), JSON.stringify(first.allEvents));
  });

  void it('produces unique event ids within a single run', async () => {
    const transport = await runScenario(55);
    const ids = transport.allEvents.map((event) => event.eventId);

    assert.strictEqual(new Set(ids).size, ids.length);
  });

  void it('never emits a timestamp earlier than the one before it', async () => {
    const transport = await runScenario(77);
    const times = transport.allEvents.map((event) => new Date(event.occurredAt).getTime());

    assert.ok(times.length > 1);
    for (let index = 1; index < times.length; index += 1) {
      assert.ok(times[index]! > times[index - 1]!);
    }
  });

  void it('overrides a clock/idGenerator supplied in config, rather than letting one win a merge', async () => {
    // The override is a runtime guarantee (object-spread order in telemetry.ts), not only a
    // type-level one — this proves it independently of TelemetryConfig's declared shape.
    const rogueTransport = new RecordingTransport();
    const rogueClock = { now: () => new Date(0) };
    const rogueIdGenerator = { next: () => 'not-seeded' };

    const client = createSeededPlaygroundTelemetry(123, {
      transport: rogueTransport,
      clock: rogueClock,
      idGenerator: rogueIdGenerator,
    });
    client.startRun({ workflowName: 'wf', workflowVersion: 'v1' }).complete();
    await client.flush();

    const seededOnly = await runScenario(123);

    assert.strictEqual(
      rogueTransport.allEvents[0]?.occurredAt,
      seededOnly.allEvents[0]?.occurredAt,
    );
    assert.strictEqual(rogueTransport.allEvents[0]?.eventId, seededOnly.allEvents[0]?.eventId);
    assert.notStrictEqual(rogueTransport.allEvents[0]?.eventId, 'not-seeded');
  });
});
