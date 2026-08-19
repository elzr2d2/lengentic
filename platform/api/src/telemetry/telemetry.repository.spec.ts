import { describe, expect, it, vi } from 'vitest';
import { TelemetryRepository } from './telemetry.repository';
import type { EntityMergeState } from './merge-rules';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The seam under test: how `EntityMergeState` (merge-rules.ts's domain type) maps onto the
 * Run/Step columns schema.prisma actually has — in particular the single shared `metadata`
 * column standing in for two logically separate slots (start-side vs completion-side
 * metadata), and `receivedAt` being create-only. The real Prisma client is not exercised
 * here (that round trip against a live schema belongs to `test/*.integration.spec.ts`, not
 * `pnpm test`) — only what THIS repository sends it and reads back from it.
 */
function fakePrismaService(): {
  prisma: PrismaService;
  run: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
  step: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
} {
  const run = { findUnique: vi.fn(), upsert: vi.fn(() => Promise.resolve()) };
  const step = { findUnique: vi.fn(), upsert: vi.fn(() => Promise.resolve()) };
  const prisma = { client: { run, step } } as unknown as PrismaService;
  return { prisma, run, step };
}

function baseState(overrides: Partial<EntityMergeState> = {}): EntityMergeState {
  return {
    entityId: 'run-1',
    status: 'RUNNING',
    startedAt: '2026-08-18T10:00:00.000Z',
    startFields: { workflowName: 'wf', workflowVersion: '1.0.0', metadata: { fromStart: true } },
    completedAt: null,
    completionFields: null,
    completionEventId: null,
    startEventId: 'evt-start',
    completionFieldOrigins: {},
    lastEventAt: 1_000,
    ...overrides,
  };
}

describe('TelemetryRepository.loadRun', () => {
  it('returns undefined when no row exists', async () => {
    const { prisma, run } = fakePrismaService();
    run.findUnique.mockResolvedValue(null);
    const repository = new TelemetryRepository(prisma);

    await expect(repository.loadRun('missing')).resolves.toBeUndefined();
  });

  it('maps a row with no completion yet — startFields carries the metadata column', async () => {
    const { prisma, run } = fakePrismaService();
    run.findUnique.mockResolvedValue({
      id: 'run-1',
      traceId: 'run-1',
      workflowName: 'wf',
      workflowVersion: '1.0.0',
      status: 'RUNNING',
      startedAt: new Date('2026-08-18T10:00:00.000Z'),
      completedAt: null,
      receivedAt: new Date('2026-08-18T10:00:00.000Z'),
      lastEventAt: new Date('2026-08-18T10:00:00.000Z'),
      startEventId: 'evt-start',
      completionEventId: null,
      metadata: { fromStart: true },
      completionFieldOrigins: {},
      createdAt: new Date('2026-08-18T10:00:00.000Z'),
    });
    const repository = new TelemetryRepository(prisma);

    const state = await repository.loadRun('run-1');

    expect(state?.status).toBe('RUNNING');
    expect(state?.startFields).toEqual({
      workflowName: 'wf',
      workflowVersion: '1.0.0',
      metadata: { fromStart: true },
    });
    expect(state?.completionFields).toBeNull();
  });

  it('maps a row where a completion has claimed the metadata key — completionFields carries it, startFields does not', async () => {
    const { prisma, run } = fakePrismaService();
    run.findUnique.mockResolvedValue({
      id: 'run-1',
      traceId: 'run-1',
      workflowName: 'wf',
      workflowVersion: '1.0.0',
      status: 'COMPLETED',
      startedAt: new Date('2026-08-18T10:00:00.000Z'),
      completedAt: new Date('2026-08-18T10:05:00.000Z'),
      receivedAt: new Date('2026-08-18T10:00:00.000Z'),
      lastEventAt: new Date('2026-08-18T10:05:00.000Z'),
      startEventId: 'evt-start',
      completionEventId: 'evt-complete',
      metadata: { fromCompletion: true },
      completionFieldOrigins: {
        metadata: { occurredAt: '2026-08-18T10:05:00.000Z', eventId: 'evt-complete' },
      },
      createdAt: new Date('2026-08-18T10:00:00.000Z'),
    });
    const repository = new TelemetryRepository(prisma);

    const state = await repository.loadRun('run-1');

    expect(state?.startFields).toEqual({ workflowName: 'wf', workflowVersion: '1.0.0' });
    expect(state?.completionFields).toEqual({ metadata: { fromCompletion: true } });
  });

  it('maps a completed row that never set a metadata key — completionFields is {} not null', async () => {
    const { prisma, run } = fakePrismaService();
    run.findUnique.mockResolvedValue({
      id: 'run-1',
      traceId: 'run-1',
      workflowName: 'wf',
      workflowVersion: '1.0.0',
      status: 'COMPLETED',
      startedAt: new Date('2026-08-18T10:00:00.000Z'),
      completedAt: new Date('2026-08-18T10:05:00.000Z'),
      receivedAt: new Date('2026-08-18T10:00:00.000Z'),
      lastEventAt: new Date('2026-08-18T10:05:00.000Z'),
      startEventId: 'evt-start',
      completionEventId: 'evt-complete',
      metadata: null,
      completionFieldOrigins: {},
      createdAt: new Date('2026-08-18T10:00:00.000Z'),
    });
    const repository = new TelemetryRepository(prisma);

    const state = await repository.loadRun('run-1');

    expect(state?.completionFields).toEqual({});
  });
});

describe('TelemetryRepository.saveRun', () => {
  it('creates with id/traceId/receivedAt, and never sends receivedAt on update', async () => {
    const { prisma, run } = fakePrismaService();
    const repository = new TelemetryRepository(prisma);

    await repository.saveRun('run-1', baseState());

    expect(run.upsert).toHaveBeenCalledTimes(1);
    const call = run.upsert.mock.calls[0]![0];
    expect(call.where).toEqual({ id: 'run-1' });
    expect(call.create).toMatchObject({ id: 'run-1', traceId: 'run-1' });
    expect(call.create.receivedAt).toBeInstanceOf(Date);
    expect(call.update).not.toHaveProperty('receivedAt');
    expect(call.update).not.toHaveProperty('id');
    expect(call.update).not.toHaveProperty('traceId');
  });

  it('stores start metadata in the shared metadata column before any completion claims it', async () => {
    const { prisma, run } = fakePrismaService();
    const repository = new TelemetryRepository(prisma);

    await repository.saveRun('run-1', baseState());

    const call = run.upsert.mock.calls[0]![0];
    expect(call.update.metadata).toEqual({ fromStart: true });
  });

  it('stores completion metadata in the shared column once completionFieldOrigins claims the key', async () => {
    const { prisma, run } = fakePrismaService();
    const repository = new TelemetryRepository(prisma);

    await repository.saveRun(
      'run-1',
      baseState({
        status: 'COMPLETED',
        completedAt: '2026-08-18T10:05:00.000Z',
        completionFields: { metadata: { fromCompletion: true } },
        completionEventId: 'evt-complete',
        completionFieldOrigins: {
          metadata: { occurredAt: '2026-08-18T10:05:00.000Z', eventId: 'evt-complete' },
        },
      }),
    );

    const call = run.upsert.mock.calls[0]![0];
    expect(call.update.metadata).toEqual({ fromCompletion: true });
  });
});

describe('TelemetryRepository.saveStep', () => {
  it('creates with id/runId/receivedAt, and never sends receivedAt or runId on update', async () => {
    const { prisma, step } = fakePrismaService();
    const repository = new TelemetryRepository(prisma);

    await repository.saveStep(
      'step-1',
      'run-1',
      baseState({
        entityId: 'step-1',
        startFields: { name: 'do-thing', agentName: 'agent', type: 'tool', parentStepId: null },
      }),
    );

    expect(step.upsert).toHaveBeenCalledTimes(1);
    const call = step.upsert.mock.calls[0]![0];
    expect(call.create).toMatchObject({ id: 'step-1', runId: 'run-1' });
    expect(call.create.receivedAt).toBeInstanceOf(Date);
    expect(call.update).not.toHaveProperty('receivedAt');
    expect(call.update).not.toHaveProperty('runId');
  });
});
