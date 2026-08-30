import { describe, expect, it } from 'vitest';

import { createTelemetryClient } from '../src/index';
import { FakeScheduler } from './support/fake-scheduler';
import { RecordingTransport } from './support/test-transports';

/**
 * F1/B (`.artifacts/evidence/3/phase-gate/repair-1/architect-f1-decision.md` §B):
 * `stats()` surfaces the API's own `accepted`/`duplicate`/`rejected` claim, not just the
 * transport's "did it round-trip" `delivered` count. Seams under test:
 *
 *   - AC-10: a parseable `IngestResponse` populates `serverAccepted`/`serverDuplicate`/
 *     `serverRejected` from the response body, and `serverCountsUnavailable` stays 0.
 *   - AC-11: an unparseable 2xx body (`response: null` — `transport.ts`'s own
 *     `readIngestResponse` fallback, and every existing test transport's default) is never
 *     read as "0 accepted": the whole batch counts under `serverCountsUnavailable` instead.
 *   - AC-12: `delivered` itself is unaffected — proven again here, not just by the
 *     unmodified `record-and-batch.spec.ts`/`shutdown.spec.ts` assertions.
 */
const fixedClock = { now: () => new Date('2026-08-30T00:00:00.000Z') };

function harness(transport: RecordingTransport) {
  const scheduler = new FakeScheduler();
  const client = createTelemetryClient({ transport, scheduler, clock: fixedClock });
  return { scheduler, client };
}

describe('server counts', () => {
  it('AC-10: a parseable IngestResponse populates serverAccepted/serverDuplicate/serverRejected', async () => {
    const transport = new RecordingTransport({
      outcome: 'delivered',
      response: {
        batchId: 'batch-1',
        accepted: 2,
        duplicate: 1,
        rejected: 0,
        results: [],
      },
    });
    const { client } = harness(transport);

    client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    await client.flush();

    expect(client.stats()).toMatchObject({
      serverAccepted: 2,
      serverDuplicate: 1,
      serverRejected: 0,
      serverCountsUnavailable: 0,
    });
  });

  it('AC-11: an unparseable 2xx (response: null) is never read as "0 accepted" — the batch counts as unavailable', async () => {
    const transport = new RecordingTransport(); // default: { outcome: 'delivered', response: null }
    const { client } = harness(transport);

    const run = client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    run.complete();
    await client.flush();

    expect(transport.allEvents.length).toBe(2); // run.started + run.completed, one batch
    expect(client.stats()).toMatchObject({
      delivered: 2,
      serverAccepted: 0,
      serverDuplicate: 0,
      serverRejected: 0,
      serverCountsUnavailable: 2,
    });
  });

  it('AC-12: delivered is unaffected by whether the response was parseable', async () => {
    const withResponse = new RecordingTransport({
      outcome: 'delivered',
      response: { batchId: 'b', accepted: 1, duplicate: 0, rejected: 0, results: [] },
    });
    const withoutResponse = new RecordingTransport();

    const first = harness(withResponse).client;
    first.startRun({ workflowName: 'w', workflowVersion: 'v' });
    await first.flush();

    const second = harness(withoutResponse).client;
    second.startRun({ workflowName: 'w', workflowVersion: 'v' });
    await second.flush();

    expect(first.stats().delivered).toBe(1);
    expect(second.stats().delivered).toBe(1);
  });

  it('sums server counts across multiple delivered batches', async () => {
    const transport = new RecordingTransport({
      outcome: 'delivered',
      response: { batchId: 'b', accepted: 1, duplicate: 0, rejected: 0, results: [] },
    });
    const { client } = harness(transport);

    const run = client.startRun({ workflowName: 'w', workflowVersion: 'v' });
    await client.flush();
    run.complete();
    await client.flush();

    expect(transport.batches.length).toBe(2);
    expect(client.stats()).toMatchObject({ delivered: 2, serverAccepted: 2 });
  });
});
