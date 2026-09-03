import { describe, expect, it } from 'vitest';

import {
  ANALYSIS_RUN_PATH,
  AnalysisRunResponseSchema,
  AnalyzerConfigSnapshotSchema,
  CounterexampleSchema,
  EvaluatedGroupSchema,
  ExclusionCountsSchema,
  GATE_IDS,
  GATE_STATUSES,
  GateResultSchema,
  GateResultsSchema,
  RECOMMENDATION_CATEGORIES,
  RECOMMENDATION_STATUSES,
  RECOMMENDATIONS_PATH,
  RecommendationEvidenceSchema,
  RecommendationGroupKeySchema,
  RecommendationSchema,
  RecommendationStatusPatchSchema,
  VERDICTS,
} from '../../index';
import type { EvaluatedGroup, Recommendation } from '../../index';

/**
 * Seam: the recommendation wire contract as a CONSUMER sees it — imported from
 * `../../index`, never from `../../schema/recommendation`. Two Definition-of-Done clauses
 * ride on that import path ("exists, is exported from the package's public entry, and is the
 * only source of the recommendation and analysis wire types"), and a spec that reached
 * straight for the module would stay green with the public export deleted.
 *
 * Every expected value below is transcribed from `MVP_PLAN_V3.md` §19, §21 and §22, never
 * read off the module under test. If the two disagree, one of these assertions must fail.
 */

const GROUP_KEY = {
  workflowName: 'demo-workflow',
  workflowVersion: 'a1b2c3d',
  decisionType: 'run_tests_after_code_change',
  contextKeyVersion: 'v1',
};

/** §19's five defaults, transcribed from the gate table at MVP_PLAN_V3.md §19. */
const DEFAULT_THRESHOLDS = {
  minSampleCount: 30,
  minDistinctContexts: 5,
  dominanceThreshold: 0.9,
  successThreshold: 0.9,
  coverageThreshold: 0.8,
};

const PASSING_GATES = [
  { id: 'G1_sample_count', status: 'PASS', comparison: '50 >= 30' },
  { id: 'G2_context_diversity', status: 'PASS', comparison: '12 >= 5' },
  { id: 'G3_dominance', status: 'PASS', comparison: '98.0% >= 90.0%' },
  { id: 'G4_outcome_success', status: 'PASS', comparison: '96.0% >= 90.0%' },
  { id: 'G5_outcome_coverage', status: 'PASS', comparison: '94.0% >= 80.0%' },
];

/** The §21 "Required output shape" worked example, as data. */
function recommendation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rec-1',
    category: 'DETERMINISTIC_CANDIDATE',
    analyzerId: 'deterministic-candidate',
    analyzerVersion: '1.0.0',
    groupKey: GROUP_KEY,
    configSnapshot: DEFAULT_THRESHOLDS,
    sourceWatermark: '2026-09-04T10:00:00.000Z',
    fingerprint: 'a'.repeat(64),
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
      minorityContextConcentration: [
        { contextKey: 'post_refactor_large_diff', count: 1, share: 1 },
      ],
      excluded: { staleRun: 0, missingContextKey: 0 },
      gates: PASSING_GATES,
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
    firstSeenAt: '2026-09-04T10:00:00.000Z',
    lastSeenAt: '2026-09-04T10:00:00.000Z',
    status: 'OPEN',
    statusNote: null,
    statusChangedAt: null,
    ...overrides,
  };
}

describe('§19 gate vocabulary on the wire', () => {
  it('GATE_IDS is exactly the five §19 gates in G1..G5 report order, frozen', () => {
    expect(GATE_IDS).toEqual([
      'G1_sample_count',
      'G2_context_diversity',
      'G3_dominance',
      'G4_outcome_success',
      'G5_outcome_coverage',
    ]);
    expect(Object.isFrozen(GATE_IDS)).toBe(true);
  });

  it('a gate status is PASS, FAIL or NOT_APPLICABLE — NOT_APPLICABLE is not a fourth spelling of PASS', () => {
    expect(GATE_STATUSES).toEqual(['PASS', 'FAIL', 'NOT_APPLICABLE']);
    expect(
      GateResultSchema.safeParse({ id: 'G1_sample_count', status: 'SKIPPED', comparison: '' })
        .success,
    ).toBe(false);
  });

  it('a verdict is CANDIDATE or SUPPRESSED, and nothing else', () => {
    expect(VERDICTS).toEqual(['CANDIDATE', 'SUPPRESSED']);
  });

  it('rejects a gate id outside the five — a sixth gate is a contract change, not a value', () => {
    expect(
      GateResultSchema.safeParse({ id: 'G6_something', status: 'PASS', comparison: 'x' }).success,
    ).toBe(false);
  });
});

describe('§21 recommendation entity', () => {
  it('parses the §21 required-output-shape example', () => {
    const parsed = RecommendationSchema.safeParse(recommendation());

    expect(parsed.success).toBe(true);
  });

  it('status is OPEN or DISMISSED — two values only (§21)', () => {
    expect(RECOMMENDATION_STATUSES).toEqual(['OPEN', 'DISMISSED']);
    expect(RecommendationSchema.safeParse(recommendation({ status: 'ACKNOWLEDGED' })).success).toBe(
      false,
    );
  });

  it('names exactly the one §21 category', () => {
    expect(RECOMMENDATION_CATEGORIES).toEqual(['DETERMINISTIC_CANDIDATE']);
  });

  it('carries no `severity` — §21 removed it, and a schema that tolerated it would let one back in', () => {
    // Not "the key is absent from the type": a Zod object strips unknown keys by default, so
    // an emitted `severity` must not survive a parse either.
    const parsed = RecommendationSchema.parse(recommendation({ severity: 'HIGH' }));

    expect(Object.keys(parsed)).not.toContain('severity');
  });

  it('requires `counterexamples` — it may be empty, it is never omitted (§20.1)', () => {
    const { counterexamples, ...withoutCounterexamples } = recommendation();

    expect(counterexamples).toBeDefined();
    expect(RecommendationSchema.safeParse(withoutCounterexamples).success).toBe(false);
    expect(RecommendationSchema.safeParse(recommendation({ counterexamples: [] })).success).toBe(
      true,
    );
  });

  it('accepts a null `dominantOptionAttestedSuccessRate` — null is not zero (§18, 5b DoD)', () => {
    const noneAttested = recommendation({
      evidence: {
        ...(recommendation().evidence as Record<string, unknown>),
        attestedCount: 0,
        dominantOptionAttestedSuccessRate: null,
      },
    });

    const parsed = RecommendationSchema.parse(noneAttested);

    expect(parsed.evidence.dominantOptionAttestedSuccessRate).toBeNull();
  });

  it('rejects an omitted `dominantOptionAttestedSuccessRate` — absent and "unknown" are different claims', () => {
    const evidence = { ...(recommendation().evidence as Record<string, unknown>) };
    delete evidence.dominantOptionAttestedSuccessRate;

    expect(RecommendationSchema.safeParse(recommendation({ evidence })).success).toBe(false);
  });

  it('rejects a fingerprint that is not 64 lowercase hex characters', () => {
    expect(RecommendationSchema.safeParse(recommendation({ fingerprint: 'nope' })).success).toBe(
      false,
    );
    expect(
      RecommendationSchema.safeParse(recommendation({ fingerprint: 'A'.repeat(64) })).success,
    ).toBe(false);
  });

  it('requires every §19 threshold in `configSnapshot` — a partial snapshot records nothing usable', () => {
    expect(AnalyzerConfigSnapshotSchema.safeParse(DEFAULT_THRESHOLDS).success).toBe(true);

    for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
      const partial: Record<string, unknown> = { ...DEFAULT_THRESHOLDS };
      delete partial[key];

      expect(AnalyzerConfigSnapshotSchema.safeParse(partial).success).toBe(false);
    }
  });

  it('a counterexample names the run, the context, the option chosen and the attested outcome', () => {
    const parsed = CounterexampleSchema.parse({
      decisionId: 'dec-c41d',
      runId: 'run-c41d',
      contextKey: 'post_refactor_large_diff',
      selectedOption: 'YES',
      outcome: 'FAILURE',
    });

    expect(parsed).toStrictEqual({
      decisionId: 'dec-c41d',
      runId: 'run-c41d',
      contextKey: 'post_refactor_large_diff',
      selectedOption: 'YES',
      outcome: 'FAILURE',
    });
  });

  it('is a compile-time contract too — Recommendation is exported beside its schema', () => {
    const typed: Recommendation = RecommendationSchema.parse(recommendation());

    expect(typed.status).toBe('OPEN');
  });
});

describe('§22 analysis response — every evaluated group, not only the emitted ones', () => {
  it('POST path and recommendations path are §21/§22 verbatim', () => {
    expect(ANALYSIS_RUN_PATH).toBe('/v1/analysis/run');
    expect(RECOMMENDATIONS_PATH).toBe('/v1/recommendations');
  });

  it('a SUPPRESSED group is a first-class row carrying every failed gate and a null recommendationId', () => {
    // §25's closing beat: a low-diversity group at SUPPRESSED / G2 context_diversity (2 < 5).
    const suppressed: EvaluatedGroup = EvaluatedGroupSchema.parse({
      groupKey: GROUP_KEY,
      verdict: 'SUPPRESSED',
      failedGates: ['G2_context_diversity'],
      gates: [
        { id: 'G1_sample_count', status: 'PASS', comparison: '31 >= 30' },
        { id: 'G2_context_diversity', status: 'FAIL', comparison: '2 >= 5' },
        { id: 'G3_dominance', status: 'PASS', comparison: '96.8% >= 90.0%' },
        { id: 'G4_outcome_success', status: 'PASS', comparison: '93.3% >= 90.0%' },
        { id: 'G5_outcome_coverage', status: 'PASS', comparison: '96.8% >= 80.0%' },
      ],
      recommendationId: null,
    });

    expect(suppressed.recommendationId).toBeNull();
    expect(suppressed.failedGates).toEqual(['G2_context_diversity']);
    expect(suppressed.gates).toHaveLength(GATE_IDS.length);
  });

  it('reports EVERY failing gate, not the first — §19 reporting rule', () => {
    const parsed = EvaluatedGroupSchema.parse({
      groupKey: GROUP_KEY,
      verdict: 'SUPPRESSED',
      failedGates: ['G2_context_diversity', 'G4_outcome_success'],
      gates: PASSING_GATES.map((gate) =>
        gate.id === 'G2_context_diversity' || gate.id === 'G4_outcome_success'
          ? { ...gate, status: 'FAIL' }
          : gate,
      ),
      recommendationId: null,
    });

    expect(parsed.failedGates).toEqual(['G2_context_diversity', 'G4_outcome_success']);
  });

  it('requires `recommendationId` to be present — an omitted id is not the same claim as a null one', () => {
    expect(
      EvaluatedGroupSchema.safeParse({
        groupKey: GROUP_KEY,
        verdict: 'SUPPRESSED',
        failedGates: ['G2_context_diversity'],
        gates: PASSING_GATES,
      }).success,
    ).toBe(false);
  });

  it('the response requires `evaluatedGroups`, and an empty analysis is an empty array', () => {
    expect(AnalysisRunResponseSchema.safeParse({}).success).toBe(false);
    expect(AnalysisRunResponseSchema.parse({ evaluatedGroups: [] })).toStrictEqual({
      evaluatedGroups: [],
    });
  });
});

describe('PATCH /v1/recommendations/:id/status — §21 { status, note? }', () => {
  it('accepts a status alone and a status with a note', () => {
    expect(RecommendationStatusPatchSchema.parse({ status: 'DISMISSED' })).toStrictEqual({
      status: 'DISMISSED',
    });
    expect(
      RecommendationStatusPatchSchema.parse({ status: 'OPEN', note: 'reopened after a re-read' }),
    ).toStrictEqual({ status: 'OPEN', note: 'reopened after a re-read' });
  });

  it('rejects a status outside §21 two values, and an empty note', () => {
    expect(RecommendationStatusPatchSchema.safeParse({ status: 'SNOOZED' }).success).toBe(false);
    expect(
      RecommendationStatusPatchSchema.safeParse({ status: 'DISMISSED', note: '' }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §19's reporting rule as behaviour rather than as prose
// ---------------------------------------------------------------------------

/** `PASSING_GATES` with the named gates flipped to FAIL. Order untouched: G1..G5. */
function gatesFailing(...ids: readonly string[]): Record<string, unknown>[] {
  return PASSING_GATES.map((gate) =>
    ids.includes(gate.id) ? { ...gate, status: 'FAIL' } : { ...gate },
  );
}

/**
 * A §22 evaluated group, valid by default, so each test below varies exactly one thing:
 * CANDIDATE, five passing gates, no failed gates, and the id of the row it was persisted as.
 */
function evaluatedGroup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    groupKey: GROUP_KEY,
    verdict: 'CANDIDATE',
    failedGates: [],
    gates: PASSING_GATES,
    recommendationId: 'rec-1',
    ...overrides,
  };
}

/**
 * Delete one key at a time and expect a parse failure — which is what "required" means on
 * the wire.
 *
 * A sweep rather than field by field, because two mutation probes at the 5b wave gate
 * (`RecommendationGroupKeySchema.decisionType` and `ExclusionCountsSchema.staleRun`, each
 * turned `.optional()`) survived the whole suite unchanged: required-ness was only ever
 * asserted for `configSnapshot`, `counterexamples` and `dominantOptionAttestedSuccessRate`.
 * An optional field is a different claim from a present one — a producer with nothing to say
 * and a producer that omits the field become the same value to every consumer — and on a
 * contract two lanes fan out from, that difference is inherited silently.
 *
 * The key is carried into the assertion so a failure names which field went missing rather
 * than reporting `true !== false`.
 */
function expectEveryFieldRequired(
  schema: { safeParse: (value: unknown) => { success: boolean } },
  valid: Record<string, unknown>,
): void {
  expect(schema.safeParse(valid).success).toBe(true);
  expect(Object.keys(valid).length).toBeGreaterThan(0);

  for (const key of Object.keys(valid)) {
    const partial: Record<string, unknown> = { ...valid };
    delete partial[key];

    expect({ omitted: key, parses: schema.safeParse(partial).success }).toStrictEqual({
      omitted: key,
      parses: false,
    });
  }
}

describe('§19 report order is held by the contract, not described by it', () => {
  it('requires exactly one result per gate — four results is a report that omits a gate', () => {
    expect(GateResultsSchema.safeParse(PASSING_GATES).success).toBe(true);
    expect(GateResultsSchema.safeParse(PASSING_GATES.slice(0, 4)).success).toBe(false);
    expect(GateResultsSchema.safeParse([]).success).toBe(false);
    expect(GateResultsSchema.safeParse([...PASSING_GATES, PASSING_GATES[0]]).success).toBe(false);
  });

  it('requires G1..G5 order — a reordered report puts the wrong gate on the wrong line', () => {
    const swapped = [
      PASSING_GATES[1],
      PASSING_GATES[0],
      PASSING_GATES[2],
      PASSING_GATES[3],
      PASSING_GATES[4],
    ];

    expect(GateResultsSchema.safeParse(swapped).success).toBe(false);
  });

  it('rejects five results that repeat one gate and drop another', () => {
    const duplicated = [
      PASSING_GATES[0],
      PASSING_GATES[1],
      PASSING_GATES[2],
      PASSING_GATES[3],
      { ...PASSING_GATES[3] },
    ];

    expect(GateResultsSchema.safeParse(duplicated).success).toBe(false);
  });

  it('holds on persisted evidence too — a stored recommendation can always render its Gates block', () => {
    const evidence = { ...(recommendation().evidence as Record<string, unknown>), gates: [] };

    expect(RecommendationSchema.safeParse(recommendation({ evidence })).success).toBe(false);
  });
});

describe("§19's reporting rule — every failing gate, not the first", () => {
  it('rejects a group that names one failing gate while two failed', () => {
    // "Suppressed by G2" when it also fails G4 understates the problem (§19), and an engineer
    // who fixes only context diversity returns to find it still suppressed.
    expect(
      EvaluatedGroupSchema.safeParse(
        evaluatedGroup({
          verdict: 'SUPPRESSED',
          failedGates: ['G2_context_diversity'],
          gates: gatesFailing('G2_context_diversity', 'G4_outcome_success'),
          recommendationId: null,
        }),
      ).success,
    ).toBe(false);
  });

  it('accepts the same group once it names both', () => {
    expect(
      EvaluatedGroupSchema.safeParse(
        evaluatedGroup({
          verdict: 'SUPPRESSED',
          failedGates: ['G2_context_diversity', 'G4_outcome_success'],
          gates: gatesFailing('G2_context_diversity', 'G4_outcome_success'),
          recommendationId: null,
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects failing gates listed out of report order', () => {
    expect(
      EvaluatedGroupSchema.safeParse(
        evaluatedGroup({
          verdict: 'SUPPRESSED',
          failedGates: ['G4_outcome_success', 'G2_context_diversity'],
          gates: gatesFailing('G2_context_diversity', 'G4_outcome_success'),
          recommendationId: null,
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects a failed gate no gate result supports — the list is derived, not asserted', () => {
    expect(
      EvaluatedGroupSchema.safeParse(
        evaluatedGroup({
          verdict: 'SUPPRESSED',
          failedGates: ['G3_dominance'],
          recommendationId: null,
        }),
      ).success,
    ).toBe(false);
  });

  it('never lists a NOT_APPLICABLE gate as failing — it is not a third spelling of FAIL', () => {
    const notApplicable = PASSING_GATES.map((gate) =>
      gate.id === 'G4_outcome_success' ? { ...gate, status: 'NOT_APPLICABLE' } : { ...gate },
    );

    expect(EvaluatedGroupSchema.safeParse(evaluatedGroup({ gates: notApplicable })).success).toBe(
      true,
    );
    expect(
      EvaluatedGroupSchema.safeParse(
        evaluatedGroup({
          verdict: 'SUPPRESSED',
          gates: notApplicable,
          failedGates: ['G4_outcome_success'],
          recommendationId: null,
        }),
      ).success,
    ).toBe(false);
  });
});

describe('§19 verdict and §22 recommendationId are derived from the gates', () => {
  it('rejects a CANDIDATE that carries a failing gate', () => {
    expect(
      EvaluatedGroupSchema.safeParse(
        evaluatedGroup({
          failedGates: ['G2_context_diversity'],
          gates: gatesFailing('G2_context_diversity'),
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects a SUPPRESSED group whose gates all passed — a refusal with nothing to render', () => {
    expect(
      EvaluatedGroupSchema.safeParse(
        evaluatedGroup({ verdict: 'SUPPRESSED', recommendationId: null }),
      ).success,
    ).toBe(false);
  });

  it('rejects a SUPPRESSED group that names a persisted row — §22 never persists one', () => {
    expect(
      EvaluatedGroupSchema.safeParse(
        evaluatedGroup({
          verdict: 'SUPPRESSED',
          failedGates: ['G2_context_diversity'],
          gates: gatesFailing('G2_context_diversity'),
          recommendationId: 'rec-1',
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects a CANDIDATE with a null recommendationId — a recommendation nothing can link to', () => {
    expect(EvaluatedGroupSchema.safeParse(evaluatedGroup({ recommendationId: null })).success).toBe(
      false,
    );
  });
});

describe('required-ness is part of the contract', () => {
  it('requires every member of §18 group key', () => {
    expectEveryFieldRequired(RecommendationGroupKeySchema, { ...GROUP_KEY });
  });

  it('requires both exclusion counts — an omitted count is not a zero count', () => {
    expectEveryFieldRequired(ExclusionCountsSchema, { staleRun: 0, missingContextKey: 0 });
  });

  it('requires every field of §21 evidence', () => {
    expectEveryFieldRequired(
      RecommendationEvidenceSchema,
      recommendation().evidence as Record<string, unknown>,
    );
  });

  it('requires every field of the §21 recommendation itself', () => {
    expectEveryFieldRequired(RecommendationSchema, recommendation());
  });

  it('requires every field of a §22 evaluated group', () => {
    expectEveryFieldRequired(EvaluatedGroupSchema, evaluatedGroup());
  });

  it('requires every field of a §20.1 counterexample', () => {
    expectEveryFieldRequired(CounterexampleSchema, {
      decisionId: 'dec-c41d',
      runId: 'run-c41d',
      contextKey: 'post_refactor_large_diff',
      selectedOption: 'YES',
      outcome: 'FAILURE',
    });
  });

  it('requires every field of a §19 gate result', () => {
    expectEveryFieldRequired(GateResultSchema, {
      id: 'G1_sample_count',
      status: 'PASS',
      comparison: '50 >= 30',
    });
  });
});

describe('§20.1 — a counterexample is a FAILURE or a SUCCESS, never an UNKNOWN', () => {
  it('rejects an UNKNOWN outcome, which names neither half of §20.1 definition', () => {
    // A counterexample is a dominant-option FAILURE or a minority-option SUCCESS.
    // `extractCounterexamples` filters on exactly those two, so UNKNOWN is a value no
    // producer can reach and a reader would have to guess at.
    expect(
      CounterexampleSchema.safeParse({
        decisionId: 'dec-c41d',
        runId: 'run-c41d',
        contextKey: 'post_refactor_large_diff',
        selectedOption: 'YES',
        outcome: 'UNKNOWN',
      }).success,
    ).toBe(false);
  });
});
