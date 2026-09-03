import { describe, expect, it, vi } from 'vitest';
import { RecommendationSchema } from '@lengentic/shared';

import { RecommendationsService, toRecommendation } from './recommendations.service';
import type { RecommendationRecord } from './recommendation-record';
import type { RecommendationsRepository } from './recommendations.repository';
import type { Clock } from '../common/clock';

/**
 * Seam: the record → wire mapping, and the one clock reading `setStatus` takes.
 *
 * The mapping's expected values are the wire contract itself: `RecommendationSchema.parse`
 * is applied to what the service produced, so a field the mapper forgets, or one it emits as
 * a `Date` rather than an ISO string, fails here rather than at the first consumer.
 */

const CHANGED_AT = new Date('2026-09-04T12:00:00.000Z');

const RECORD: RecommendationRecord = {
  id: 'rec-1',
  category: 'DETERMINISTIC_CANDIDATE',
  analyzerId: 'deterministic-candidate',
  analyzerVersion: '1.0.0',
  groupKey: {
    workflowName: 'demo-workflow',
    workflowVersion: 'a1b2c3d',
    decisionType: 'run_tests_after_code_change',
    contextKeyVersion: 'v1',
  },
  configSnapshot: {
    minSampleCount: 30,
    minDistinctContexts: 5,
    dominanceThreshold: 0.9,
    successThreshold: 0.9,
    coverageThreshold: 0.8,
  },
  sourceWatermark: new Date('2026-09-04T08:59:00.000Z'),
  fingerprint: 'b'.repeat(64),
  evidence: {
    sampleCount: 50,
    distinctContextKeyCount: 12,
    optionDistribution: [
      { option: 'YES', count: 49, share: 0.98 },
      { option: 'NO', count: 1, share: 0.02 },
    ],
    dominantOption: 'YES',
    dominancePercentage: 0.98,
    attestedCount: 47,
    outcomeCoverage: 0.94,
    dominantOptionAttestedSuccessRate: 0.96,
    minorityContextConcentration: [{ contextKey: 'post_refactor_large_diff', count: 1, share: 1 }],
    excluded: { staleRun: 0, missingContextKey: 0 },
    gates: [
      { id: 'G1_sample_count', status: 'PASS', comparison: '50 >= 30' },
      { id: 'G2_context_diversity', status: 'PASS', comparison: '12 >= 5' },
      { id: 'G3_dominance', status: 'PASS', comparison: '98.0% >= 90.0%' },
      { id: 'G4_outcome_success', status: 'PASS', comparison: '96.0% >= 90.0%' },
      { id: 'G5_outcome_coverage', status: 'PASS', comparison: '94.0% >= 80.0%' },
    ],
  },
  counterexamples: [
    {
      decisionId: 'dec-8f2a',
      runId: 'run-8f2a',
      contextKey: 'post_refactor_large_diff',
      selectedOption: 'NO',
      outcome: 'SUCCESS',
    },
  ],
  firstSeenAt: new Date('2026-09-04T09:00:00.000Z'),
  lastSeenAt: new Date('2026-09-04T17:30:00.000Z'),
  status: 'OPEN',
  statusNote: null,
  statusChangedAt: null,
};

function serviceOver(
  repository: Partial<RecommendationsRepository>,
  clock: Clock = { now: () => CHANGED_AT },
): RecommendationsService {
  return new RecommendationsService(repository as RecommendationsRepository, clock);
}

describe('toRecommendation', () => {
  it('produces a value the wire contract accepts', () => {
    expect(RecommendationSchema.safeParse(toRecommendation(RECORD)).success).toBe(true);
  });

  it('renders every instant as an ISO string, including the nullable one', () => {
    const open = toRecommendation(RECORD);

    expect(open.sourceWatermark).toBe('2026-09-04T08:59:00.000Z');
    expect(open.firstSeenAt).toBe('2026-09-04T09:00:00.000Z');
    expect(open.lastSeenAt).toBe('2026-09-04T17:30:00.000Z');
    expect(open.statusChangedAt).toBeNull();

    const dismissed = toRecommendation({ ...RECORD, statusChangedAt: CHANGED_AT });

    expect(dismissed.statusChangedAt).toBe('2026-09-04T12:00:00.000Z');
  });

  it('carries counterexamples through as an array of its own, not the record’s', () => {
    const view = toRecommendation(RECORD);

    expect(view.counterexamples).toStrictEqual([...RECORD.counterexamples]);
    expect(view.counterexamples).not.toBe(RECORD.counterexamples);
  });

  it('preserves a null dominantOptionAttestedSuccessRate — never a manufactured 0', () => {
    const unattested = toRecommendation({
      ...RECORD,
      evidence: { ...RECORD.evidence, attestedCount: 0, dominantOptionAttestedSuccessRate: null },
    });

    expect(unattested.evidence.dominantOptionAttestedSuccessRate).toBeNull();
  });
});

describe('RecommendationsService', () => {
  it('records a sighting through the repository and returns the wire shape', async () => {
    const recordSighting = vi.fn(() => Promise.resolve(RECORD));
    const service = serviceOver({ recordSighting });

    const result = await service.recordSighting({
      category: RECORD.category,
      analyzerId: RECORD.analyzerId,
      analyzerVersion: RECORD.analyzerVersion,
      groupKey: RECORD.groupKey,
      configSnapshot: RECORD.configSnapshot,
      sourceWatermark: RECORD.sourceWatermark,
      evidence: RECORD.evidence,
      counterexamples: RECORD.counterexamples,
      observedAt: RECORD.firstSeenAt,
    });

    expect(recordSighting).toHaveBeenCalledTimes(1);
    expect(result).toStrictEqual(toRecommendation(RECORD));
  });

  it('stamps a status change with the injected clock, not with an ambient Date.now()', async () => {
    // Observed through the repository's own argument rather than through a spy on Date: a
    // service that read the clock itself would still satisfy an assertion about the result.
    const setStatus = vi.fn(() =>
      Promise.resolve({ ...RECORD, status: 'DISMISSED' as const, statusChangedAt: CHANGED_AT }),
    );
    const service = serviceOver({ setStatus }, { now: () => CHANGED_AT });

    await service.setStatus('rec-1', { status: 'DISMISSED', note: 'known trade-off' });

    expect(setStatus).toHaveBeenCalledWith('rec-1', 'DISMISSED', 'known trade-off', CHANGED_AT);
  });

  it('passes a null note when the patch carries none — absent is not empty', async () => {
    const setStatus = vi.fn(() => Promise.resolve(RECORD));
    const service = serviceOver({ setStatus });

    await service.setStatus('rec-1', { status: 'OPEN' });

    expect(setStatus).toHaveBeenCalledWith('rec-1', 'OPEN', null, CHANGED_AT);
  });

  it('reports undefined for an unknown id rather than inventing a recommendation', async () => {
    const service = serviceOver({
      setStatus: () => Promise.resolve(undefined),
      findById: () => Promise.resolve(undefined),
    });

    await expect(service.setStatus('nope', { status: 'DISMISSED' })).resolves.toBeUndefined();
    await expect(service.findById('nope')).resolves.toBeUndefined();
  });
});
