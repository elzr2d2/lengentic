import { describe, expect, it } from 'vitest';
import type { Clock } from '../common/clock';
import type { RunRecord, StepRecord } from './run-record';
import { RunsService } from './runs.service';
import type { RunsRepository } from './runs.repository';
import { RunDetailViewSchema, RunListViewSchema } from '@lengentic/shared/read';

/**
 * Seam: `RunsService`, observed through its two public methods. Everything the endpoints do
 * beyond HTTP lives here — the STALE substitution, the record-to-view mapping, and paging —
 * so this is where those are pinned.
 *
 * The repository is a fake, not a mock: it holds records and honours `take`/`skip` the way
 * Postgres would, so `hasMore` is observed as a property of the returned page rather than
 * asserted against a call the service happened to make. A test that asserted "the service
 * asked for limit + 1" would pass on an implementation that then ignored the extra row.
 *
 * The clock is fixed at 2026-08-21T12:00:00.000Z and the threshold is passed explicitly, so
 * no case below depends on `Date.now()`, on the environment, or on elapsed real time.
 */
const NOW = new Date('2026-08-21T12:00:00.000Z');
const THIRTY_MINUTES_MS = 1_800_000;

const FIXED_CLOCK: Clock = { now: () => NOW };

function runRecord(overrides: Partial<RunRecord> & Pick<RunRecord, 'id'>): RunRecord {
  return {
    traceId: overrides.id,
    workflowName: 'checkout-agent',
    workflowVersion: '1.4.0',
    status: 'RUNNING',
    startedAt: new Date('2026-08-21T11:00:00.000Z'),
    completedAt: null,
    receivedAt: new Date('2026-08-21T11:00:00.000Z'),
    lastEventAt: new Date('2026-08-21T11:59:00.000Z'),
    metadata: { region: 'eu-west-1' },
    ...overrides,
  };
}

function stepRecord(overrides: Partial<StepRecord> & Pick<StepRecord, 'id' | 'runId'>): StepRecord {
  return {
    parentStepId: null,
    name: 'fetch-cart',
    agentName: 'checkout-agent',
    type: 'tool',
    status: 'RUNNING',
    startedAt: new Date('2026-08-21T11:00:05.000Z'),
    completedAt: null,
    receivedAt: new Date('2026-08-21T11:00:05.000Z'),
    metadata: null,
    ...overrides,
  };
}

/**
 * `as unknown as RunsRepository` is the test-double carve-out `docs/ENGINEERING_STANDARDS.md`
 * TS-3 allows and `health.service.spec.ts` already uses: the object satisfies every method
 * the service calls, and nothing else on the class is reachable from here.
 */
function fakeRepository(runs: readonly RunRecord[], steps: readonly StepRecord[]): RunsRepository {
  return {
    listRuns: (take: number, skip: number) => Promise.resolve(runs.slice(skip, skip + take)),
    findRun: (id: string) => Promise.resolve(runs.find((run) => run.id === id)),
    listSteps: (runId: string) => Promise.resolve(steps.filter((step) => step.runId === runId)),
  } as unknown as RunsRepository;
}

function serviceOver(runs: readonly RunRecord[], steps: readonly StepRecord[] = []): RunsService {
  return new RunsService(fakeRepository(runs, steps), FIXED_CLOCK, THIRTY_MINUTES_MS);
}

describe('RunsService.list', () => {
  it('reports RUNNING for a live run and STALE for a silent one, in the same page', async () => {
    // Both halves in one assertion: a derivation that always returns STALE and one that
    // never does each satisfy half of this, and only the pairing catches either.
    const service = serviceOver([
      runRecord({ id: 'run-live', lastEventAt: new Date('2026-08-21T11:59:00.000Z') }),
      runRecord({ id: 'run-silent', lastEventAt: new Date('2026-08-21T08:00:00.000Z') }),
    ]);

    const page = await service.list({ limit: 50, offset: 0 });

    expect(page.runs.map((run) => [run.id, run.status])).toStrictEqual([
      ['run-live', 'RUNNING'],
      ['run-silent', 'STALE'],
    ]);
  });

  it('never reports STALE for a run whose stored status is terminal', async () => {
    const service = serviceOver([
      runRecord({
        id: 'run-done',
        status: 'COMPLETED',
        completedAt: new Date('2026-01-01T00:00:00.000Z'),
        lastEventAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      runRecord({
        id: 'run-failed',
        status: 'FAILED',
        completedAt: new Date('2026-01-01T00:00:00.000Z'),
        lastEventAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ]);

    const page = await service.list({ limit: 50, offset: 0 });

    expect(page.runs.map((run) => run.status)).toStrictEqual(['COMPLETED', 'FAILED']);
  });

  it('renders every instant as an ISO-8601 string, not a Date', async () => {
    // Expected values are the fixture literals above, read off the fixture and not off the
    // response: `receivedAt` was written as 11:00:00.000Z, so 11:00:00.000Z is what must
    // come back.
    const service = serviceOver([runRecord({ id: 'run-1' })]);

    const [run] = (await service.list({ limit: 50, offset: 0 })).runs;

    expect(run?.startedAt).toBe('2026-08-21T11:00:00.000Z');
    expect(run?.receivedAt).toBe('2026-08-21T11:00:00.000Z');
    expect(run?.lastEventAt).toBe('2026-08-21T11:59:00.000Z');
    expect(run?.completedAt).toBeNull();
  });

  it('carries the run identity and workflow grouping columns through', async () => {
    const service = serviceOver([
      runRecord({ id: 'run-1', workflowName: 'checkout-agent', workflowVersion: '1.4.0' }),
    ]);

    const [run] = (await service.list({ limit: 50, offset: 0 })).runs;

    expect(run?.id).toBe('run-1');
    expect(run?.traceId).toBe('run-1');
    expect(run?.workflowName).toBe('checkout-agent');
    expect(run?.workflowVersion).toBe('1.4.0');
    expect(run?.metadata).toStrictEqual({ region: 'eu-west-1' });
  });

  it('reports the workflow columns as null before the run.started event has landed', async () => {
    // §12 permits a completion event to arrive first; `schema.prisma` makes both columns
    // nullable for exactly that case. The response must say null, not invent a name.
    const service = serviceOver([
      runRecord({ id: 'run-1', workflowName: null, workflowVersion: null, startedAt: null }),
    ]);

    const [run] = (await service.list({ limit: 50, offset: 0 })).runs;

    expect(run?.workflowName).toBeNull();
    expect(run?.workflowVersion).toBeNull();
    expect(run?.startedAt).toBeNull();
  });

  it('returns a full page and says there is more', async () => {
    const runs = Array.from({ length: 5 }, (_, index) => runRecord({ id: `run-${String(index)}` }));

    const page = await serviceOver(runs).list({ limit: 2, offset: 0 });

    expect(page.runs.map((run) => run.id)).toStrictEqual(['run-0', 'run-1']);
    expect(page.hasMore).toBe(true);
    expect(page.limit).toBe(2);
    expect(page.offset).toBe(0);
  });

  it('says there is no more on the exact last page', async () => {
    // The boundary a naive `records.length === limit` implementation gets wrong: four
    // records, page size two, offset two — a full page AND the end of the collection.
    const runs = Array.from({ length: 4 }, (_, index) => runRecord({ id: `run-${String(index)}` }));

    const page = await serviceOver(runs).list({ limit: 2, offset: 2 });

    expect(page.runs.map((run) => run.id)).toStrictEqual(['run-2', 'run-3']);
    expect(page.hasMore).toBe(false);
  });

  it('returns an empty page past the end without failing', async () => {
    const page = await serviceOver([runRecord({ id: 'run-0' })]).list({ limit: 2, offset: 10 });

    expect(page.runs).toStrictEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('produces a page that satisfies the published response schema', async () => {
    const page = await serviceOver([runRecord({ id: 'run-1' })]).list({ limit: 50, offset: 0 });

    expect(RunListViewSchema.safeParse(page).success).toBe(true);
  });
});

describe('RunsService.findById', () => {
  it('returns undefined for a run id that does not exist', async () => {
    await expect(serviceOver([]).findById('run-missing')).resolves.toBeUndefined();
  });

  it('returns the run with its steps, in ingestion order', async () => {
    const service = serviceOver(
      [runRecord({ id: 'run-1' })],
      [
        stepRecord({ id: 'step-root', runId: 'run-1' }),
        stepRecord({ id: 'step-child', runId: 'run-1', parentStepId: 'step-root' }),
      ],
    );

    const detail = await service.findById('run-1');

    expect(detail?.id).toBe('run-1');
    expect(detail?.steps.map((step) => [step.id, step.parentStepId])).toStrictEqual([
      ['step-root', null],
      ['step-child', 'step-root'],
    ]);
  });

  it('keeps an orphaned step in the response instead of filtering it out', async () => {
    // §13 gives parentStepId no foreign key so a child can arrive before its parent. A
    // response that silently dropped it would lose a real row and make the Dashboard's
    // orphan rendering untestable.
    const service = serviceOver(
      [runRecord({ id: 'run-1' })],
      [stepRecord({ id: 'step-child', runId: 'run-1', parentStepId: 'step-never-arrived' })],
    );

    const detail = await service.findById('run-1');

    expect(detail?.steps.map((step) => step.id)).toStrictEqual(['step-child']);
    expect(detail?.steps[0]?.parentStepId).toBe('step-never-arrived');
  });

  it('does not return steps belonging to another run', async () => {
    const service = serviceOver(
      [runRecord({ id: 'run-1' }), runRecord({ id: 'run-2' })],
      [stepRecord({ id: 'step-a', runId: 'run-1' }), stepRecord({ id: 'step-b', runId: 'run-2' })],
    );

    const detail = await service.findById('run-2');

    expect(detail?.steps.map((step) => step.id)).toStrictEqual(['step-b']);
  });

  it('reports STALE on the run while its steps keep their stored status', async () => {
    // The one place the derived/stored split is visible in a single payload. Step has no
    // `lastEventAt` (schema.prisma: "liveness is a Run concept"), so a step-level STALE
    // would be a claim from an observation the system never made.
    const service = serviceOver(
      [runRecord({ id: 'run-1', lastEventAt: new Date('2026-08-21T08:00:00.000Z') })],
      [stepRecord({ id: 'step-a', runId: 'run-1', status: 'RUNNING' })],
    );

    const detail = await service.findById('run-1');

    expect(detail?.status).toBe('STALE');
    expect(detail?.steps[0]?.status).toBe('RUNNING');
  });

  it('renders step instants as ISO-8601 strings', async () => {
    const service = serviceOver(
      [runRecord({ id: 'run-1' })],
      [
        stepRecord({
          id: 'step-a',
          runId: 'run-1',
          completedAt: new Date('2026-08-21T11:00:09.000Z'),
          status: 'COMPLETED',
        }),
      ],
    );

    const detail = await service.findById('run-1');

    expect(detail?.steps[0]?.startedAt).toBe('2026-08-21T11:00:05.000Z');
    expect(detail?.steps[0]?.completedAt).toBe('2026-08-21T11:00:09.000Z');
    expect(detail?.steps[0]?.receivedAt).toBe('2026-08-21T11:00:05.000Z');
  });

  it('returns a run with no steps as an empty array, not as an absent field', async () => {
    const detail = await serviceOver([runRecord({ id: 'run-1' })]).findById('run-1');

    expect(detail?.steps).toStrictEqual([]);
  });

  it('produces a detail that satisfies the published response schema', async () => {
    const detail = await serviceOver(
      [runRecord({ id: 'run-1' })],
      [stepRecord({ id: 'step-a', runId: 'run-1' })],
    ).findById('run-1');

    expect(RunDetailViewSchema.safeParse(detail).success).toBe(true);
  });
});
