import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { DecisionsModule } from './decisions.module';
import { DecisionsRepository } from './decisions.repository';
import { DecisionsService } from './decisions.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Wiring only: can the container actually build this module's graph, and does the module
 * hand out the seam a caller would ask for.
 *
 * Worth its own file because the failure it catches is invisible to every other test here —
 * `decisions.service.spec.ts` and `decisions.repository.spec.ts` construct their subjects
 * with `new`, so a missing provider, a missing `exports` entry or a decorator Nest cannot
 * read would leave both green and the capability unreachable at runtime.
 *
 * `PrismaService` arrives the same way it does in production — from a `@Global` module, the
 * shape `prisma.module.ts` has and the reason `DecisionsModule` imports nothing — rather
 * than via `overrideProvider`, which only replaces a provider already in the graph. The
 * value behind it is a double: the real `PrismaService` opens a database connection in its
 * constructor, and this test is about the graph, not about Postgres.
 */
function fakePrismaModule(client: unknown): new () => object {
  @Global()
  @Module({
    providers: [{ provide: PrismaService, useValue: { client } }],
    exports: [PrismaService],
  })
  class FakePrismaModule {}

  return FakePrismaModule;
}

describe('DecisionsModule', () => {
  it('resolves DecisionsService and reaches the database through its repository', async () => {
    const upsert = vi.fn(() => Promise.resolve());
    const moduleRef = await Test.createTestingModule({
      imports: [fakePrismaModule({ decision: { upsert } }), DecisionsModule],
    }).compile();

    // Resolved from this module's own exports, which is what "the module provides it" means.
    const service = moduleRef.get(DecisionsService);

    await service.attestOutcome({
      eventId: 'evt-1',
      schemaVersion: '2',
      type: 'decision.outcome_attested',
      entityId: 'dec-1',
      runId: 'run-9',
      occurredAt: '2026-08-31T12:00:00.000Z',
      payload: { outcome: 'SUCCESS' },
    });

    // The injected repository really is this module's, and the call really reached Prisma —
    // a graph that had quietly substituted something else would leave this at zero.
    expect(moduleRef.get(DecisionsRepository)).toBeInstanceOf(DecisionsRepository);
    expect(upsert).toHaveBeenCalledTimes(1);

    await moduleRef.close();
  });

  // p4.entity-ingest: `record` is the second capability this module now provides, added
  // alongside the pre-existing attestation path. Same graph, same reason to test it here —
  // `decisions.service.spec.ts` constructs `DecisionsService` with `new`, which cannot catch
  // a provider or export missing from the module's own wiring.
  it('resolves DecisionsService.record too, through the same graph', async () => {
    const upsert = vi.fn(() => Promise.resolve());
    const moduleRef = await Test.createTestingModule({
      imports: [fakePrismaModule({ decision: { upsert } }), DecisionsModule],
    }).compile();

    const service = moduleRef.get(DecisionsService);

    await service.record({
      eventId: 'evt-2',
      schemaVersion: '2',
      type: 'decision.recorded',
      entityId: 'dec-2',
      runId: 'run-9',
      occurredAt: '2026-09-02T10:00:00.000Z',
      payload: {
        stepId: 'step-1',
        decisionType: 'execution_strategy',
        availableOptions: ['sequential', 'parallel'],
        selectedOption: 'sequential',
      },
    });

    expect(upsert).toHaveBeenCalledTimes(1);

    await moduleRef.close();
  });
});
