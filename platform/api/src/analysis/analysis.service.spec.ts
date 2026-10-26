import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type AnalyzerConfig } from '@lengentic/analysis-engine';
import type {
  EvaluatedGroup,
  Recommendation,
  RepeatedFailedActionRecommendation,
} from '@lengentic/shared';

import { AnalysisService } from './analysis.service';
import type { AnalysisRepository } from './analysis.repository';
import type { AnalysisDecisionSource } from './analysis-source';
import type { Clock } from '../common/clock';
import type {
  RecommendationSighting,
  RepeatedFailedActionSighting,
} from '../recommendations/recommendation-record';
import type { AnalysisToolCallSource } from './repeated-failed-source';
import type { RecommendationsService } from '../recommendations/recommendations.service';

/**
 * Seam: `AnalysisService.run()` — its two collaborators (`AnalysisRepository`,
 * `RecommendationsService`) faked, and the real `@lengentic/analysis-engine` running inside.
 *
 * The engine is deliberately NOT faked. §18's aggregation and §19's gates are the behaviour
 * under test here as much as the service's own loop, and a fake engine would let this file
 * assert that the service persisted whatever a stub told it to — which is true of a service
 * that persists SUPPRESSED groups as readily as one that refuses them. The gate thresholds
 * are `DEFAULT_CONFIG`, injected, so a fixture that clears them clears the real §19 gates.
 *
 * `RecommendationsService` IS faked, because it is the write. What was written is then
 * observable as an argument rather than as a database state, which is what makes "nothing was
 * written" assertable at all.
 *
 * ## The fixture numbers
 *
 * The candidate corpus below is probe P2 from `.artifacts/evidence/5b/wave-gate-validator.md`
 * — 40 decisions, 38 YES / 2 NO over 9 context keys, 36 of the 38 dominant-option outcomes
 * SUCCESS. Those figures and their five gate results were computed by hand before the endpoint
 * existed and then confirmed against a real Postgres, so they are a second source rather than
 * a transcription of this module's arithmetic.
 *
 * The negative corpora come first. A SUPPRESSED group that gets persisted is not a cosmetic
 * defect: §22 says there is no suppression table, and a row written for a refusal is a claim
 * the product decided not to make, sitting in the table consumers read.
 */

const OBSERVED_AT = new Date('2026-09-04T12:00:00.000Z');
const NEWEST_CREATED_AT = new Date('2026-09-03T18:30:00.000Z');
const STALE_THRESHOLD_MS = 1_800_000;

function source(overrides: Partial<AnalysisDecisionSource> = {}): AnalysisDecisionSource {
  return {
    decisionId: 'dec-1',
    runId: 'run-1',
    runStatus: 'COMPLETED',
    runLastEventAt: new Date('2026-09-03T18:00:00.000Z'),
    workflowName: 'demo-workflow',
    workflowVersion: 'a1b2c3d',
    decisionType: 'run_tests_after_code_change',
    contextKey: 'ctx_0',
    contextKeyVersion: 'v1',
    availableOptions: ['YES', 'NO'],
    selectedOption: 'YES',
    outcome: 'SUCCESS',
    outcomeAttestedBy: 'CALLER',
    createdAt: new Date('2026-09-03T10:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Probe P2's corpus. 38 YES across ctx_0..ctx_7 (36 SUCCESS, 2 FAILURE) plus 2 NO in
 * `post_refactor` (1 SUCCESS, 1 FAILURE): 40 samples, 9 distinct contexts, 95.0% dominance,
 * 94.7% attested success for YES, 100% coverage. Every §19 gate passes.
 */
function candidateCorpus(
  overrides: Partial<AnalysisDecisionSource> = {},
): AnalysisDecisionSource[] {
  const rows: AnalysisDecisionSource[] = [];

  for (let i = 0; i < 38; i += 1) {
    rows.push(
      source({
        decisionId: `dec-yes-${String(i)}`,
        contextKey: `ctx_${String(i % 8)}`,
        selectedOption: 'YES',
        outcome: i < 36 ? 'SUCCESS' : 'FAILURE',
        ...overrides,
      }),
    );
  }

  for (let i = 0; i < 2; i += 1) {
    rows.push(
      source({
        decisionId: `dec-no-${String(i)}`,
        contextKey: 'post_refactor',
        selectedOption: 'NO',
        outcome: i === 0 ? 'SUCCESS' : 'FAILURE',
        ...overrides,
      }),
    );
  }

  // The newest instant in the corpus, so `sourceWatermark` has one right answer that is not
  // the clock reading.
  rows[rows.length - 1] = { ...rows[rows.length - 1]!, createdAt: NEWEST_CREATED_AT };

  return rows;
}

/** Three decisions over two contexts: G1, G2 and G5 all fail. Nothing may be persisted. */
function suppressedCorpus(): AnalysisDecisionSource[] {
  return [
    source({
      decisionId: 'dec-a',
      decisionType: 'batch_iteration_size',
      contextKey: 'ctx_a',
      outcome: 'UNKNOWN',
      outcomeAttestedBy: 'UNKNOWN',
    }),
    source({
      decisionId: 'dec-b',
      decisionType: 'batch_iteration_size',
      contextKey: 'ctx_a',
      outcome: 'UNKNOWN',
      outcomeAttestedBy: 'UNKNOWN',
    }),
    source({
      decisionId: 'dec-c',
      decisionType: 'batch_iteration_size',
      contextKey: 'ctx_b',
      outcome: 'UNKNOWN',
      outcomeAttestedBy: 'UNKNOWN',
    }),
  ];
}

interface Harness {
  readonly service: AnalysisService;
  readonly recordSighting: ReturnType<typeof vi.fn>;
  readonly withdrawOnSuppression: ReturnType<typeof vi.fn>;
  readonly recordRepeatedFailedAction: ReturnType<typeof vi.fn>;
  readonly withdrawRepeatedExcept: ReturnType<typeof vi.fn>;
}

function serviceOver(
  sources: readonly AnalysisDecisionSource[],
  clock: Clock = { now: () => OBSERVED_AT },
  config: AnalyzerConfig = DEFAULT_CONFIG,
  toolCalls: readonly AnalysisToolCallSource[] = [],
): Harness {
  let issued = 0;
  const recordSighting = vi.fn((sighting: RecommendationSighting) => {
    issued += 1;
    return Promise.resolve({
      id: `rec-${String(issued)}`,
      ...sighting,
    } as unknown as Recommendation);
  });

  const withdrawOnSuppression = vi.fn(() => Promise.resolve('ABSENT' as const));

  const recordRepeatedFailedAction = vi.fn((sighting: RepeatedFailedActionSighting) => {
    issued += 1;
    return Promise.resolve({
      id: `rfa-${String(issued)}`,
      fingerprint: `fp-${sighting.actionKey.runId}-${sighting.actionKey.toolName}`,
      ...sighting,
    } as unknown as RepeatedFailedActionRecommendation);
  });
  const withdrawRepeatedExcept = vi.fn((_emitted: readonly string[]) => Promise.resolve(0));

  const repository = {
    listDecisionsForAnalysis: () => Promise.resolve([...sources]),
    listToolCallsForAnalysis: () => Promise.resolve([...toolCalls]),
  } as unknown as AnalysisRepository;

  return {
    service: new AnalysisService(
      repository,
      {
        recordSighting,
        withdrawOnSuppression,
        recordRepeatedFailedActionSighting: recordRepeatedFailedAction,
        withdrawRepeatedFailedActionsExcept: withdrawRepeatedExcept,
      } as unknown as RecommendationsService,
      clock,
      STALE_THRESHOLD_MS,
      config,
    ),
    recordSighting,
    withdrawOnSuppression,
    recordRepeatedFailedAction,
    withdrawRepeatedExcept,
  };
}

function sightingOf(recordSighting: ReturnType<typeof vi.fn>, index = 0): RecommendationSighting {
  return recordSighting.mock.calls[index]?.[0] as RecommendationSighting;
}

describe('AnalysisService.run — a SUPPRESSED group persists no Recommendation row', () => {
  it('writes nothing for an under-sampled group, and names it SUPPRESSED with a null id', async () => {
    const { service, recordSighting } = serviceOver(suppressedCorpus());

    const response = await service.run();

    expect(recordSighting.mock.calls).toStrictEqual([]);
    expect(response.evaluatedGroups).toHaveLength(1);
    expect(response.evaluatedGroups[0]?.verdict).toBe('SUPPRESSED');
    expect(response.evaluatedGroups[0]?.recommendationId).toBeNull();
  });

  it('reports EVERY failing gate, not the first (§19)', async () => {
    const { service } = serviceOver(suppressedCorpus());

    const response = await service.run();

    // 3 samples (< 30), 2 contexts (< 5), nothing attested (0% < 80%). An engineer told only
    // about G1 would fix sample count and return to find the group still suppressed.
    expect(response.evaluatedGroups[0]?.failedGates).toStrictEqual([
      'G1_sample_count',
      'G2_context_diversity',
      'G5_outcome_coverage',
    ]);
  });

  it('writes nothing when a run nobody has heard from in a day is the only source', async () => {
    // §39's STALE rule, reached through the service's own clock reading. Every row is excluded,
    // so G1 compares a zero denominator and the group is refused. This is the false positive
    // the product exists to decline: a stale run must not produce a claim.
    const { service, recordSighting } = serviceOver(
      candidateCorpus({
        runStatus: 'RUNNING',
        runLastEventAt: new Date(OBSERVED_AT.getTime() - 24 * 60 * 60 * 1000),
      }),
    );

    const response = await service.run();

    expect(recordSighting.mock.calls).toStrictEqual([]);
    expect(response.evaluatedGroups[0]?.verdict).toBe('SUPPRESSED');
    expect(response.evaluatedGroups[0]?.gates[0]?.comparison).toBe('0 >= 30');
  });

  it('answers an empty database with an empty result rather than an empty claim', async () => {
    const { service, recordSighting } = serviceOver([]);

    await expect(service.run()).resolves.toStrictEqual({
      evaluatedGroups: [],
      repeatedFailedActions: [],
    });
    expect(recordSighting.mock.calls).toStrictEqual([]);
  });

  it('persists only the CANDIDATE when both verdicts are in one run', async () => {
    const { service, recordSighting } = serviceOver([...candidateCorpus(), ...suppressedCorpus()]);

    const response = await service.run();

    expect(response.evaluatedGroups).toHaveLength(2);
    expect(recordSighting).toHaveBeenCalledTimes(1);
    expect(sightingOf(recordSighting).groupKey.decisionType).toBe('run_tests_after_code_change');

    const byVerdict = new Map(
      response.evaluatedGroups.map((group: EvaluatedGroup) => [group.verdict, group]),
    );

    expect(byVerdict.get('CANDIDATE')?.recommendationId).toBe('rec-1');
    expect(byVerdict.get('SUPPRESSED')?.recommendationId).toBeNull();
  });

  it('withdraws the row a suppressed group may already have — not writing one is not the same as none existing', async () => {
    // "Do not write a row" and "no row exists" are different claims, and the 5b phase gate
    // found daylight between them: a group that was a CANDIDATE last run and is SUPPRESSED
    // this run kept its row, its OPEN status and the superseded evidence, and the list read
    // went on serving it (Tester FINDING 1). §22's line is about the table, so the suppressed
    // branch has to ASK about the row rather than silently skip it.
    const { service, recordSighting, withdrawOnSuppression } = serviceOver(suppressedCorpus());

    await service.run();

    expect(recordSighting.mock.calls).toStrictEqual([]);
    expect(withdrawOnSuppression).toHaveBeenCalledTimes(1);
    expect(
      (withdrawOnSuppression.mock.calls[0]?.[0] as RecommendationSighting).groupKey.decisionType,
    ).toBe('batch_iteration_size');
  });

  it('hands the withdrawal THIS run evidence, so a kept tombstone cannot serve the superseded claim', async () => {
    // The DISMISSED row that survives a suppression is refreshed rather than frozen
    // (`docs/decisions/0015`). It can only be refreshed if the suppressing run's own evidence
    // reaches the write — the defect being repaired is a row whose evidence its gates no
    // longer support, and a stale tombstone is that defect with a different status column.
    const { service, withdrawOnSuppression } = serviceOver(suppressedCorpus());

    await service.run();

    const withdrawn = withdrawOnSuppression.mock.calls[0]?.[0] as RecommendationSighting;

    expect(withdrawn.evidence.sampleCount).toBe(3);
    expect(withdrawn.evidence.gates.map((gate) => gate.status)).toStrictEqual([
      'FAIL',
      'FAIL',
      'PASS',
      'NOT_APPLICABLE',
      'FAIL',
    ]);
    expect(withdrawn.observedAt).toStrictEqual(OBSERVED_AT);
  });

  it('never withdraws a row for a group it has just persisted', async () => {
    // The paired negative. A withdrawal on the CANDIDATE path would delete the recommendation
    // the same run just wrote, and the response would name an id with no row behind it.
    const { service, withdrawOnSuppression } = serviceOver(candidateCorpus());

    await service.run();

    expect(withdrawOnSuppression.mock.calls).toStrictEqual([]);
  });
});

describe('AnalysisService.run — what a persisted CANDIDATE carries', () => {
  it('names the row the response points at', async () => {
    const { service, recordSighting } = serviceOver(candidateCorpus());

    const response = await service.run();

    expect(recordSighting).toHaveBeenCalledTimes(1);
    expect(response.evaluatedGroups[0]?.verdict).toBe('CANDIDATE');
    expect(response.evaluatedGroups[0]?.failedGates).toStrictEqual([]);
    expect(response.evaluatedGroups[0]?.recommendationId).toBe('rec-1');
  });

  it('carries EVERY counterexample onto the row — the field may be empty, never emptied', async () => {
    // §20.1: a dominant-option FAILURE or a minority-option SUCCESS. This corpus has two of
    // the first and one of the second. A producer that wrote `counterexamples: []` would ship
    // a recommendation with its counterevidence deleted, which `CLAUDE.md` ## Product claims
    // has no degraded mode for.
    const { service, recordSighting } = serviceOver(candidateCorpus());

    await service.run();

    const sighting = sightingOf(recordSighting);

    expect(sighting.counterexamples).toHaveLength(3);
    expect(
      sighting.counterexamples.filter((c) => c.selectedOption === 'YES' && c.outcome === 'FAILURE'),
    ).toHaveLength(2);
    expect(
      sighting.counterexamples.filter((c) => c.selectedOption === 'NO' && c.outcome === 'SUCCESS'),
    ).toHaveLength(1);
  });

  it('records an EMPTY counterexample array when a group is unanimous — the key is never dropped', async () => {
    const unanimous = candidateCorpus().map((row) => ({
      ...row,
      selectedOption: 'YES',
      outcome: 'SUCCESS' as const,
    }));
    const { service, recordSighting } = serviceOver(unanimous);

    await service.run();

    const sighting = sightingOf(recordSighting);

    expect(Object.keys(sighting)).toContain('counterexamples');
    expect(sighting.counterexamples).toStrictEqual([]);
  });

  it('stamps §21 sourceWatermark with the newest source instant, not with the clock', async () => {
    // §21: "what data range it was computed over". The clock reading says when the ANALYSIS
    // ran; the watermark says how far the DATA reached, and the two are different questions.
    // Using the clock would report a range that always ends now, whatever was actually read.
    const { service, recordSighting } = serviceOver(candidateCorpus());

    await service.run();

    expect(sightingOf(recordSighting).sourceWatermark).toStrictEqual(NEWEST_CREATED_AT);
    expect(sightingOf(recordSighting).sourceWatermark).not.toStrictEqual(OBSERVED_AT);
  });

  it('records §20.1 analyzer identity and §19 thresholds in force', async () => {
    const { service, recordSighting } = serviceOver(candidateCorpus());

    await service.run();

    const sighting = sightingOf(recordSighting);

    expect(sighting.analyzerId).toBe('deterministic-candidate');
    expect(sighting.analyzerVersion).toBe('1.0.0');
    expect(sighting.category).toBe('DETERMINISTIC_CANDIDATE');
    expect(sighting.configSnapshot).toStrictEqual({
      minSampleCount: 30,
      minDistinctContexts: 5,
      dominanceThreshold: 0.9,
      successThreshold: 0.9,
      coverageThreshold: 0.8,
    });
  });

  it('records the evidence §21 output shape renders, with the numbers probe P2 computed by hand', async () => {
    const { service, recordSighting } = serviceOver(candidateCorpus());

    await service.run();

    const { evidence } = sightingOf(recordSighting);

    expect(evidence.sampleCount).toBe(40);
    expect(evidence.distinctContextKeyCount).toBe(9);
    expect(evidence.dominantOption).toBe('YES');
    expect(evidence.attestedCount).toBe(40);
    expect(evidence.gates.map((gate) => gate.id)).toStrictEqual([
      'G1_sample_count',
      'G2_context_diversity',
      'G3_dominance',
      'G4_outcome_success',
      'G5_outcome_coverage',
    ]);
    expect(evidence.gates.every((gate) => gate.status === 'PASS')).toBe(true);
  });

  it('never manufactures a 0.0% attested rate — null when the dominant option has none', async () => {
    // Every attested outcome belongs to the MINORITY option, so the dominant option's rate is
    // unknown rather than zero. §19's G4 is NOT_APPLICABLE for exactly this, which is what
    // still allows a candidate, and the Dashboard renders `N/A` from this null.
    //
    // The coverage threshold is shifted so the group survives G5 on its 2/40 attested rows —
    // the seam `analyzer-config.provider.ts` exists for, and the only way to reach the
    // NOT_APPLICABLE branch on a CANDIDATE without an environment variable.
    const unattestedDominant = candidateCorpus().map((row) =>
      row.selectedOption === 'YES'
        ? { ...row, outcome: 'UNKNOWN' as const, outcomeAttestedBy: 'UNKNOWN' as const }
        : row,
    );
    const { service, recordSighting } = serviceOver(
      unattestedDominant,
      { now: () => OBSERVED_AT },
      {
        ...DEFAULT_CONFIG,
        coverageThreshold: 0.04,
      },
    );

    const response = await service.run();

    expect(response.evaluatedGroups[0]?.verdict).toBe('CANDIDATE');
    expect(recordSighting).toHaveBeenCalledTimes(1);

    const { evidence } = sightingOf(recordSighting);

    // Null, and specifically not 0: `0.0%` would say every attested outcome failed, and the
    // two send a reader to opposite conclusions.
    expect(evidence.dominantOptionAttestedSuccessRate).toBeNull();
    expect(evidence.gates[3]?.id).toBe('G4_outcome_success');
    expect(evidence.gates[3]?.status).toBe('NOT_APPLICABLE');
  });
});

describe('AnalysisService.run — one clock reading for the whole run', () => {
  it('stamps every recommendation from one run with the same observedAt, under an advancing clock', async () => {
    // A clock read per group would let two recommendations emitted by one analysis disagree
    // about when that analysis happened, and would let the STALE rule classify one group's run
    // as live and a later one's as stale on the strength of the clock moving mid-loop.
    let ticks = 0;
    const advancing: Clock = {
      now: () => {
        ticks += 1;
        return new Date(OBSERVED_AT.getTime() + ticks * 1000);
      },
    };

    const twoGroups = [
      ...candidateCorpus(),
      ...candidateCorpus().map((row) => ({
        ...row,
        decisionId: `${row.decisionId}-b`,
        decisionType: 'select_model',
      })),
    ];

    const { service, recordSighting } = serviceOver(twoGroups, advancing);

    await service.run();

    expect(recordSighting).toHaveBeenCalledTimes(2);
    expect(sightingOf(recordSighting, 0).observedAt).toStrictEqual(
      sightingOf(recordSighting, 1).observedAt,
    );
    expect(ticks).toBe(1);
  });
});

function toolCall(overrides: Partial<AnalysisToolCallSource> = {}): AnalysisToolCallSource {
  return {
    toolCallId: 'tc-1',
    runId: 'run-1',
    toolName: 'run_tests',
    inputFingerprint: 'fp-input-a',
    success: false,
    error: 'AssertionError',
    startedAt: new Date('2026-09-03T10:00:00.000Z'),
    ...overrides,
  };
}

/** Attempt `n` (1-based) of the same call, one minute apart. */
function attempt(n: number, overrides: Partial<AnalysisToolCallSource> = {}) {
  return toolCall({
    toolCallId: `tc-${String(n)}`,
    startedAt: new Date(Date.UTC(2026, 8, 3, 10, n)),
    ...overrides,
  });
}

describe('AnalysisService.run — §20.2 repeated failed action (negatives first)', () => {
  it('persists nothing for two failures', async () => {
    const { service, recordRepeatedFailedAction } = serviceOver([], undefined, undefined, [
      attempt(1),
      attempt(2),
    ]);

    const response = await service.run();

    expect(recordRepeatedFailedAction).not.toHaveBeenCalled();
    expect(response.repeatedFailedActions).toStrictEqual([]);
  });

  it('persists nothing when a success sits between the failures', async () => {
    const { service, recordRepeatedFailedAction } = serviceOver([], undefined, undefined, [
      attempt(1),
      attempt(2),
      attempt(3, { success: true, error: null }),
      attempt(4),
      attempt(5),
    ]);

    await service.run();

    expect(recordRepeatedFailedAction).not.toHaveBeenCalled();
  });

  it('persists nothing for three failures spread across three runs', async () => {
    const { service, recordRepeatedFailedAction } = serviceOver([], undefined, undefined, [
      attempt(1, { runId: 'run-1' }),
      attempt(2, { runId: 'run-2' }),
      attempt(3, { runId: 'run-3' }),
    ]);

    await service.run();

    expect(recordRepeatedFailedAction).not.toHaveBeenCalled();
  });

  it('persists nothing for three failures of three DIFFERENT inputs', async () => {
    const { service, recordRepeatedFailedAction } = serviceOver([], undefined, undefined, [
      attempt(1, { inputFingerprint: 'a' }),
      attempt(2, { inputFingerprint: 'b' }),
      attempt(3, { inputFingerprint: 'c' }),
    ]);

    await service.run();

    expect(recordRepeatedFailedAction).not.toHaveBeenCalled();
  });

  it('persists nothing for failures that carry no fingerprint — unknown input is not equal input', async () => {
    const { service, recordRepeatedFailedAction } = serviceOver([], undefined, undefined, [
      attempt(1, { inputFingerprint: null }),
      attempt(2, { inputFingerprint: null }),
      attempt(3, { inputFingerprint: null }),
    ]);

    await service.run();

    expect(recordRepeatedFailedAction).not.toHaveBeenCalled();
  });
});

describe('AnalysisService.run — §20.2 emission', () => {
  const THREE = [attempt(1), attempt(2), attempt(3)];

  it('persists exactly one recommendation for three consecutive failures, naming all three calls', async () => {
    const { service, recordRepeatedFailedAction } = serviceOver([], undefined, undefined, THREE);

    const response = await service.run();

    expect(recordRepeatedFailedAction).toHaveBeenCalledTimes(1);
    const sighting = recordRepeatedFailedAction.mock.calls[0]?.[0] as RepeatedFailedActionSighting;
    expect(sighting.category).toBe('REPEATED_FAILED_ACTION');
    expect(sighting.actionKey).toStrictEqual({
      runId: 'run-1',
      toolName: 'run_tests',
      inputFingerprint: 'fp-input-a',
    });
    expect(sighting.evidence).toStrictEqual({
      attemptCount: 3,
      toolCallIds: ['tc-1', 'tc-2', 'tc-3'],
    });
    expect(response.repeatedFailedActions).toHaveLength(1);
    expect(response.repeatedFailedActions?.[0]?.recommendationId).toBe('rfa-1');
  });

  it('records the analyzer identity and the threshold in force', async () => {
    const { service, recordRepeatedFailedAction } = serviceOver([], undefined, undefined, THREE);

    await service.run();

    const sighting = recordRepeatedFailedAction.mock.calls[0]?.[0] as RepeatedFailedActionSighting;
    expect(sighting.analyzerId).toBe('repeated-failed-action');
    expect(sighting.analyzerVersion).toBe('1.0.0');
    expect(sighting.configSnapshot).toStrictEqual({ minConsecutiveFailures: 3 });
  });

  it('records an EMPTY counterexample array when nothing succeeded — the key is never dropped', async () => {
    const { service, recordRepeatedFailedAction } = serviceOver([], undefined, undefined, THREE);

    await service.run();

    const sighting = recordRepeatedFailedAction.mock.calls[0]?.[0] as RepeatedFailedActionSighting;
    expect(sighting.counterexamples).toStrictEqual([]);
  });

  it('lists the success that ended the streak as a counterexample', async () => {
    const { service, recordRepeatedFailedAction } = serviceOver([], undefined, undefined, [
      ...THREE,
      attempt(4, { success: true, error: null }),
    ]);

    await service.run();

    const sighting = recordRepeatedFailedAction.mock.calls[0]?.[0] as RepeatedFailedActionSighting;
    expect(sighting.counterexamples).toStrictEqual([
      { toolCallId: 'tc-4', runId: 'run-1', outcome: 'SUCCESS' },
    ]);
  });

  it('counts an errored call that reported success as failed — the §20.2 disjunction', async () => {
    const { service, recordRepeatedFailedAction } = serviceOver([], undefined, undefined, [
      attempt(1, { success: true, error: 'recorded an Error' }),
      attempt(2),
      attempt(3),
    ]);

    await service.run();

    expect(recordRepeatedFailedAction).toHaveBeenCalledTimes(1);
  });

  it('folds two streaks of one key into ONE row, keeping the longer — one fingerprint, one row', async () => {
    const { service, recordRepeatedFailedAction } = serviceOver([], undefined, undefined, [
      attempt(1),
      attempt(2),
      attempt(3),
      attempt(4, { success: true, error: null }),
      attempt(5),
      attempt(6),
      attempt(7),
      attempt(8),
    ]);

    await service.run();

    expect(recordRepeatedFailedAction).toHaveBeenCalledTimes(1);
    const sighting = recordRepeatedFailedAction.mock.calls[0]?.[0] as RepeatedFailedActionSighting;
    expect(sighting.evidence.toolCallIds).toStrictEqual(['tc-5', 'tc-6', 'tc-7', 'tc-8']);
    expect(sighting.counterexamples).toStrictEqual([
      { toolCallId: 'tc-4', runId: 'run-1', outcome: 'SUCCESS' },
    ]);
  });

  it('withdraws every persisted row the run did not emit, keyed by the emitted fingerprints', async () => {
    const { service, withdrawRepeatedExcept } = serviceOver([], undefined, undefined, THREE);

    await service.run();

    expect(withdrawRepeatedExcept).toHaveBeenCalledTimes(1);
    expect(withdrawRepeatedExcept.mock.calls[0]?.[0]).toStrictEqual(['fp-run-1-run_tests']);
  });

  it('withdraws against an EMPTY emitted set when nothing qualifies — a vanished streak leaves no row', async () => {
    const { service, withdrawRepeatedExcept } = serviceOver([], undefined, undefined, []);

    await service.run();

    expect(withdrawRepeatedExcept.mock.calls[0]?.[0]).toStrictEqual([]);
  });

  it('stamps the watermark with the newest tool call, not the clock', async () => {
    const { service, recordRepeatedFailedAction } = serviceOver([], undefined, undefined, THREE);

    await service.run();

    const sighting = recordRepeatedFailedAction.mock.calls[0]?.[0] as RepeatedFailedActionSighting;
    expect(sighting.sourceWatermark).toStrictEqual(new Date(Date.UTC(2026, 8, 3, 10, 3)));
    expect(sighting.observedAt).toStrictEqual(OBSERVED_AT);
  });
});
