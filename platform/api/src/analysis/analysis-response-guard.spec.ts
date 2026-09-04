import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '@lengentic/analysis-engine';
import type { EvaluatedGroup, GateResults, Recommendation } from '@lengentic/shared';

import { AnalysisService } from './analysis.service';
import type { AnalysisDecisionSource } from './analysis-source';
import type { AnalysisRepository } from './analysis.repository';
import type { Clock } from '../common/clock';
import type { RecommendationsService } from '../recommendations/recommendations.service';

/**
 * Seam: the `AnalysisRunResponseSchema.parse` at the end of `AnalysisService.run`, and only
 * that.
 *
 * It is defence in depth against ONE failure — the engine-to-wire mapper next door emitting a
 * group that violates §19's reporting rule or §22's `recommendationId` biconditional — and the
 * mapper is the only thing that can produce one. So the mapper is the thing this file replaces,
 * and nothing else is faked but the two collaborators the run needs to reach it.
 *
 * A file of its own because `vi.mock` is hoisted per file: `analysis.service.spec.ts` runs the
 * REAL mapper against the real engine, which is the point of that file, and a module mock at
 * its top would quietly weaken all thirteen of its tests.
 *
 * The 5b wave gate recorded why this is worth binding at all. Deleting the `parse` (mutant
 * M19) passed the whole suite; and mutant M17 — persisting SUPPRESSED groups instead of
 * CANDIDATEs — was caught in the integration probe ONLY because this parse refused the group
 * it produced. Without it, M17 is a wrong claim on the wire instead of a 500, and
 * `CLAUDE.md` ## Product claims is explicit about which of those is worse.
 */

const mapper = vi.hoisted(() => ({
  override: null as null | (() => EvaluatedGroup),
}));

vi.mock('./evaluated-group', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./evaluated-group')>();

  return {
    ...actual,
    toEvaluatedGroup: (
      ...args: Parameters<typeof actual.toEvaluatedGroup>
    ): ReturnType<typeof actual.toEvaluatedGroup> =>
      mapper.override === null ? actual.toEvaluatedGroup(...args) : mapper.override(),
  };
});

const OBSERVED_AT = new Date('2026-09-04T12:00:00.000Z');

const GROUP_KEY = {
  workflowName: 'demo-workflow',
  workflowVersion: 'a1b2c3d',
  decisionType: 'batch_iteration_size',
  contextKeyVersion: 'v1',
};

/**
 * Two gates FAIL. Anything that reports fewer is the understated report §19 forbids.
 *
 * `X >= Y` on a FAIL as well as a PASS: `countGate` and `ratioGate`
 * (`analysis-engine/src/gates.ts:115,123`) build one string for both statuses, so a `2 < 5`
 * here would be a comparison no producer can emit.
 */
const TWO_FAILURES: GateResults = [
  { id: 'G1_sample_count', status: 'PASS', comparison: '40 >= 30' },
  { id: 'G2_context_diversity', status: 'FAIL', comparison: '2 >= 5' },
  { id: 'G3_dominance', status: 'PASS', comparison: '96.0% >= 90.0%' },
  { id: 'G4_outcome_success', status: 'FAIL', comparison: '61.0% >= 90.0%' },
  { id: 'G5_outcome_coverage', status: 'PASS', comparison: '88.0% >= 80.0%' },
];

function source(decisionId: string, contextKey: string): AnalysisDecisionSource {
  return {
    decisionId,
    runId: 'run-1',
    runStatus: 'COMPLETED',
    runLastEventAt: OBSERVED_AT,
    workflowName: 'demo-workflow',
    workflowVersion: 'a1b2c3d',
    decisionType: 'batch_iteration_size',
    contextKey,
    contextKeyVersion: 'v1',
    availableOptions: ['YES', 'NO'],
    selectedOption: 'YES',
    outcome: 'UNKNOWN',
    outcomeAttestedBy: 'UNKNOWN',
    createdAt: OBSERVED_AT,
  };
}

function service(): AnalysisService {
  const repository = {
    listDecisionsForAnalysis: () =>
      Promise.resolve([source('dec-a', 'ctx_a'), source('dec-b', 'ctx_b')]),
  } as unknown as AnalysisRepository;

  const recommendations = {
    recordSighting: () => Promise.resolve({ id: 'rec-1' } as unknown as Recommendation),
    // A SUPPRESSED group withdraws whatever row it left behind (§22, and `docs/decisions/0015`
    // for the DISMISSED tombstone). Every fixture here suppresses, so the run reaches this.
    withdrawOnSuppression: () => Promise.resolve('ABSENT' as const),
  } as unknown as RecommendationsService;

  const clock: Clock = { now: () => OBSERVED_AT };

  return new AnalysisService(repository, recommendations, clock, 1_800_000, DEFAULT_CONFIG);
}

describe('AnalysisService.run parses its own output before returning it', () => {
  it('refuses a group that names fewer failing gates than it has — §19 understated report', async () => {
    mapper.override = () => ({
      groupKey: GROUP_KEY,
      verdict: 'SUPPRESSED',
      // G4 also fails. "Suppressed by G2" sends an engineer to fix context diversity and
      // return to find the group still suppressed — the exact thing §19 spends a paragraph
      // forbidding, and a shape a consumer cannot tell from an honest one.
      failedGates: ['G2_context_diversity'],
      gates: TWO_FAILURES,
      dominantOptionAttestedSuccessRate: 0.61,
      recommendationId: null,
    });

    await expect(service().run()).rejects.toThrow(/failedGates|reporting rule/i);

    mapper.override = null;
  });

  it('refuses a CANDIDATE that names no persisted row — §22 biconditional', async () => {
    mapper.override = () => ({
      groupKey: GROUP_KEY,
      verdict: 'CANDIDATE',
      failedGates: [],
      gates: TWO_FAILURES.map((gate) => ({ ...gate, status: 'PASS' as const })),
      dominantOptionAttestedSuccessRate: 0.61,
      // A recommendation nothing can link to. The response would render a claim with no row
      // behind it.
      recommendationId: null,
    });

    await expect(service().run()).rejects.toThrow(/recommendationId/i);

    mapper.override = null;
  });

  it('lets the real mapper output through untouched — the guard is not a filter', async () => {
    mapper.override = null;

    const response = await service().run();

    expect(response.evaluatedGroups).toHaveLength(1);
    expect(response.evaluatedGroups[0]?.verdict).toBe('SUPPRESSED');
  });
});
