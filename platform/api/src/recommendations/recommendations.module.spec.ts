import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { RecommendationsController } from './recommendations.controller';
import { RecommendationsModule } from './recommendations.module';
import { RecommendationsRepository } from './recommendations.repository';
import { RecommendationsService } from './recommendations.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Wiring only: can the container build this module's graph, and does it hand out the seam a
 * caller would ask for.
 *
 * Worth its own file because the failure it catches is invisible to every other spec here —
 * the service, repository and controller specs all construct their subjects with `new`, so a
 * missing provider, a missing `exports` entry, an unregistered controller or a `CLOCK` token
 * nobody bound would leave all three green and the capability unreachable at runtime. That
 * exact mutant (emptying `DecisionsModule.exports`) survived the Phase 4 wave-4 gate.
 *
 * `PrismaService` arrives the way it does in production — from a `@Global` module, which is
 * why `RecommendationsModule` imports nothing — rather than via `overrideProvider`, which
 * only replaces a provider already in the graph. The value behind it is a double: the real
 * `PrismaService` opens a database connection in its constructor.
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

const ROW = {
  id: 'rec-1',
  category: 'DETERMINISTIC_CANDIDATE',
  analyzerId: 'deterministic-candidate',
  analyzerVersion: '1.0.0',
  workflowName: 'demo-workflow',
  workflowVersion: 'a1b2c3d',
  decisionType: 'run_tests_after_code_change',
  contextKeyVersion: 'v1',
  configSnapshot: {
    minSampleCount: 30,
    minDistinctContexts: 5,
    dominanceThreshold: 0.9,
    successThreshold: 0.9,
    coverageThreshold: 0.8,
  },
  sourceWatermark: new Date('2026-09-04T08:59:00.000Z'),
  fingerprint: 'c'.repeat(64),
  evidence: {
    sampleCount: 50,
    distinctContextKeyCount: 12,
    optionDistribution: [{ option: 'YES', count: 50, share: 1 }],
    dominantOption: 'YES',
    dominancePercentage: 1,
    attestedCount: 47,
    outcomeCoverage: 0.94,
    dominantOptionAttestedSuccessRate: 0.96,
    minorityContextConcentration: [],
    excluded: { staleRun: 0, missingContextKey: 0 },
    // Five results in G1..G5 order, because `RecommendationEvidenceSchema` now requires them
    // (§19's report order) and `toRecommendationRecord` parses this column on the way out.
    gates: [
      { id: 'G1_sample_count', status: 'PASS', comparison: '50 >= 30' },
      { id: 'G2_context_diversity', status: 'PASS', comparison: '12 >= 5' },
      { id: 'G3_dominance', status: 'PASS', comparison: '100.0% >= 90.0%' },
      { id: 'G4_outcome_success', status: 'PASS', comparison: '96.0% >= 90.0%' },
      { id: 'G5_outcome_coverage', status: 'PASS', comparison: '94.0% >= 80.0%' },
    ],
  },
  counterexamples: [],
  firstSeenAt: new Date('2026-09-04T09:00:00.000Z'),
  lastSeenAt: new Date('2026-09-04T09:00:00.000Z'),
  status: 'DISMISSED',
  statusNote: 'known trade-off',
  statusChangedAt: new Date('2026-09-04T12:00:00.000Z'),
};

describe('RecommendationsModule', () => {
  it('resolves RecommendationsService and reaches the database through its repository', async () => {
    const updateManyAndReturn = vi.fn(() => Promise.resolve([ROW]));
    const moduleRef = await Test.createTestingModule({
      imports: [
        fakePrismaModule({ recommendation: { updateManyAndReturn } }),
        RecommendationsModule,
      ],
    }).compile();

    // Resolved from this module's own exports, which is what "the module provides it" means.
    const service = moduleRef.get(RecommendationsService);

    const updated = await service.setStatus('rec-1', {
      status: 'DISMISSED',
      note: 'known trade-off',
    });

    expect(updated?.status).toBe('DISMISSED');
    expect(moduleRef.get(RecommendationsRepository)).toBeInstanceOf(RecommendationsRepository);
    expect(updateManyAndReturn).toHaveBeenCalledTimes(1);

    await moduleRef.close();
  });

  it('registers the controller, so §21s PATCH route has somewhere to land', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [fakePrismaModule({ recommendation: {} }), RecommendationsModule],
    }).compile();

    expect(moduleRef.get(RecommendationsController)).toBeInstanceOf(RecommendationsController);

    await moduleRef.close();
  });

  it('binds a CLOCK, so a status change is stamped rather than throwing on an unresolved token', async () => {
    const updateManyAndReturn = vi.fn((args: { data: { statusChangedAt: Date } }) =>
      Promise.resolve([{ ...ROW, statusChangedAt: args.data.statusChangedAt }]),
    );
    const moduleRef = await Test.createTestingModule({
      imports: [
        fakePrismaModule({ recommendation: { updateManyAndReturn } }),
        RecommendationsModule,
      ],
    }).compile();

    const before = Date.now();
    await moduleRef.get(RecommendationsService).setStatus('rec-1', { status: 'DISMISSED' });
    const after = Date.now();

    const stamped = updateManyAndReturn.mock.calls[0]?.[0].data.statusChangedAt;

    expect(stamped).toBeInstanceOf(Date);
    expect(stamped!.getTime()).toBeGreaterThanOrEqual(before);
    expect(stamped!.getTime()).toBeLessThanOrEqual(after);

    await moduleRef.close();
  });
});
