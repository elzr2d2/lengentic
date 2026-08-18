/**
 * The two Phase 5a expectation grids, transcribed as typed data.
 *
 * PROVENANCE — this is the whole reason the file exists.
 *
 * `GATE_EXPECTATION_GRID` is the `Gate expectation grid` of MVP_PLAN_V3 Phase 5.
 * `THRESHOLD_BOUNDARY_ROWS` is the `Threshold boundary rows` table of the same section.
 * Those two tables are the ONLY legal source for a Phase 5a expected value. Nothing here
 * was read off `pnpm spike`, off `spike/aggregate.ts`, off `spike/gates.ts`, off a spike
 * fixture's own `expect` block, or off `platform/analysis-engine/src/**`. An expectation
 * sourced from the implementation cannot fail when the implementation is wrong.
 *
 * `spike/` DISAGREES with the `counterexamples` column on seven of the twelve grid rows,
 * by design. That column originally counted minority-SELECTED rows; §20.1 counts
 * dominant-option FAILURE rows plus minority-option SUCCESS rows, which is a different
 * population. Corrected 2026-08-17: D1 1->3, D2 3->4, D3 3->7, D4 2->4, D6 2->22,
 * D9 18->16, D11 2->0. `spike/aggregate.ts:133` still computes the old reading. Do not
 * reconcile the two; `spike/` is an independent cross-check, never an oracle.
 *
 * PERCENTAGES ARE STORED AS RATIOS. The grid prints `98.00%`; this file stores `0.98`.
 * Gates compare ratios and never percentages scaled by 100 — `0.9 * 100` is
 * `90.00000000000001`, which would turn `B3-at`, a row whose whole job is to sit exactly on
 * the threshold and PASS, into a silent failure that looks like a fixture bug.
 *
 * `N-A` in the grid is `NOT_APPLICABLE` here, and a `dominantOptionAttestedSuccessRate` of
 * `null`. Null is not zero: a group with no attested outcomes for its dominant option has an
 * UNKNOWN rate, and rendering that as 0.0% is the lie §2 forbids.
 */
import type { GateId, GateStatus, Verdict } from '../src/gate-contract';

/**
 * The grid's gate columns, in the plan's own report order G1..G5.
 *
 * Declared here rather than imported from `src/gate-contract.ts` so this wave imports no
 * runtime value from the engine at all. The ids are still bound: `GateId` is the engine's
 * type, so a typo here is a compile error, and `test/contract/public-entry.spec.ts` already
 * pins `GATE_IDS` to the same five literals against §19.
 */
export const GRID_GATE_ORDER: readonly GateId[] = [
  'G1_sample_count',
  'G2_context_diversity',
  'G3_dominance',
  'G4_outcome_success',
  'G5_outcome_coverage',
];

/**
 * One cell per gate, keyed by `GateId`. A mapped type rather than an array so that a row
 * missing a gate cell is a COMPILE error rather than a meta-test failure.
 */
export type GateCells = { readonly [K in GateId]: GateStatus };

export interface GridRow {
  /** Fixture id. `D8` occupies two rows, distinguished by `workflowVersion`. */
  readonly id: string;
  /** Which of the two plan tables this row was transcribed from. */
  readonly source: 'gate-expectation-grid' | 'threshold-boundary-rows';
  /**
   * The `workflowVersion` of the group this row describes. `D8` splits on it before gating;
   * for every other fixture it simply names the group's only version.
   */
  readonly workflowVersion: string;
  readonly sampleCount: number;
  readonly distinctContextKeyCount: number;
  readonly dominantOption: string;
  /** Ratio 0..1. The grid's `dominance` column divided by 100. */
  readonly dominancePercentage: number;
  /** Ratio 0..1. The grid's `coverage` column divided by 100. */
  readonly outcomeCoverage: number;
  /** Ratio 0..1, or `null` where the grid says `N-A` / _undefined_. Never `0` for N-A. */
  readonly dominantOptionAttestedSuccessRate: number | null;
  readonly gates: GateCells;
  readonly verdict: Verdict;
  /** Exactly the gates whose cell is FAIL. Compared as a SET; `NOT_APPLICABLE` never here. */
  readonly failedGates: readonly GateId[];
  /** The grid's `counterexamples` column — §20.1's definition and nothing else. */
  readonly counterexampleCount: number;
}

// Aliases, so a fifteen-row transcription stays one readable line per row.
const G1 = 'G1_sample_count' satisfies GateId;
const G2 = 'G2_context_diversity' satisfies GateId;
const G3 = 'G3_dominance' satisfies GateId;
const G4 = 'G4_outcome_success' satisfies GateId;
const G5 = 'G5_outcome_coverage' satisfies GateId;

const PASS = 'PASS' satisfies GateStatus;
const FAIL = 'FAIL' satisfies GateStatus;
const NA = 'NOT_APPLICABLE' satisfies GateStatus;

const allPass: GateCells = {
  G1_sample_count: PASS,
  G2_context_diversity: PASS,
  G3_dominance: PASS,
  G4_outcome_success: PASS,
  G5_outcome_coverage: PASS,
};

/** `allPass` with the named cells overridden. Keeps a fifteen-row table readable. */
const cells = (overrides: Partial<GateCells>): GateCells => ({ ...allPass, ...overrides });

/**
 * `Gate expectation grid`, MVP_PLAN_V3 Phase 5. Twelve rows for eleven fixtures: `D8`
 * splits on `workflowVersion` before gating and therefore occupies two.
 */
export const GATE_EXPECTATION_GRID: readonly GridRow[] = [
  {
    id: 'D1',
    source: 'gate-expectation-grid',
    workflowVersion: 'a1b2c3d',
    sampleCount: 50,
    distinctContextKeyCount: 12,
    dominantOption: 'YES',
    dominancePercentage: 0.98,
    outcomeCoverage: 0.94,
    dominantOptionAttestedSuccessRate: 0.9565,
    gates: allPass,
    verdict: 'CANDIDATE',
    failedGates: [],
    counterexampleCount: 3,
  },
  {
    id: 'D2',
    source: 'gate-expectation-grid',
    workflowVersion: 'a1b2c3d',
    sampleCount: 40,
    distinctContextKeyCount: 9,
    dominantOption: 'SKIP',
    dominancePercentage: 0.925,
    outcomeCoverage: 0.9,
    dominantOptionAttestedSuccessRate: 0.9143,
    gates: allPass,
    verdict: 'CANDIDATE',
    failedGates: [],
    counterexampleCount: 4,
  },
  {
    id: 'D3',
    source: 'gate-expectation-grid',
    workflowVersion: 'a1b2c3d',
    sampleCount: 50,
    distinctContextKeyCount: 10,
    dominantOption: 'YES',
    dominancePercentage: 0.94,
    outcomeCoverage: 1.0,
    dominantOptionAttestedSuccessRate: 0.9149,
    gates: allPass,
    verdict: 'CANDIDATE',
    failedGates: [],
    counterexampleCount: 7,
  },
  {
    id: 'D4',
    source: 'gate-expectation-grid',
    workflowVersion: 'a1b2c3d',
    sampleCount: 50,
    distinctContextKeyCount: 2,
    dominantOption: 'YES',
    dominancePercentage: 0.96,
    outcomeCoverage: 0.96,
    dominantOptionAttestedSuccessRate: 0.9565,
    gates: cells({ G2_context_diversity: FAIL }),
    verdict: 'SUPPRESSED',
    failedGates: ['G2_context_diversity'],
    counterexampleCount: 4,
  },
  {
    id: 'D5',
    source: 'gate-expectation-grid',
    workflowVersion: 'a1b2c3d',
    sampleCount: 12,
    distinctContextKeyCount: 8,
    dominantOption: 'YES',
    dominancePercentage: 1.0,
    outcomeCoverage: 1.0,
    dominantOptionAttestedSuccessRate: 1.0,
    gates: cells({ G1_sample_count: FAIL }),
    verdict: 'SUPPRESSED',
    failedGates: ['G1_sample_count'],
    counterexampleCount: 0,
  },
  {
    id: 'D6',
    source: 'gate-expectation-grid',
    workflowVersion: 'a1b2c3d',
    sampleCount: 60,
    distinctContextKeyCount: 15,
    dominantOption: 'YES',
    dominancePercentage: 0.9667,
    outcomeCoverage: 0.9333,
    dominantOptionAttestedSuccessRate: 0.6111,
    gates: cells({ G4_outcome_success: FAIL }),
    verdict: 'SUPPRESSED',
    failedGates: ['G4_outcome_success'],
    counterexampleCount: 22,
  },
  {
    id: 'D7',
    source: 'gate-expectation-grid',
    workflowVersion: 'a1b2c3d',
    sampleCount: 50,
    distinctContextKeyCount: 10,
    dominantOption: 'YES',
    dominancePercentage: 0.96,
    outcomeCoverage: 0.6,
    dominantOptionAttestedSuccessRate: 0.9655,
    gates: cells({ G5_outcome_coverage: FAIL }),
    verdict: 'SUPPRESSED',
    failedGates: ['G5_outcome_coverage'],
    counterexampleCount: 2,
  },
  {
    id: 'D8',
    source: 'gate-expectation-grid',
    workflowVersion: 'a1b2c3d',
    sampleCount: 26,
    distinctContextKeyCount: 8,
    dominantOption: 'YES',
    dominancePercentage: 0.9615,
    outcomeCoverage: 1.0,
    dominantOptionAttestedSuccessRate: 1.0,
    gates: cells({ G1_sample_count: FAIL }),
    verdict: 'SUPPRESSED',
    failedGates: ['G1_sample_count'],
    counterexampleCount: 1,
  },
  {
    id: 'D8',
    source: 'gate-expectation-grid',
    workflowVersion: 'e4f5a6b',
    sampleCount: 24,
    distinctContextKeyCount: 8,
    dominantOption: 'YES',
    dominancePercentage: 0.9583,
    outcomeCoverage: 1.0,
    dominantOptionAttestedSuccessRate: 1.0,
    gates: cells({ G1_sample_count: FAIL }),
    verdict: 'SUPPRESSED',
    failedGates: ['G1_sample_count'],
    counterexampleCount: 1,
  },
  {
    id: 'D9',
    source: 'gate-expectation-grid',
    workflowVersion: 'a1b2c3d',
    sampleCount: 45,
    distinctContextKeyCount: 11,
    dominantOption: 'YES',
    dominancePercentage: 0.6,
    outcomeCoverage: 0.9556,
    dominantOptionAttestedSuccessRate: 0.9615,
    gates: cells({ G3_dominance: FAIL }),
    verdict: 'SUPPRESSED',
    failedGates: ['G3_dominance'],
    counterexampleCount: 16,
  },
  {
    // The only row in the corpus that fails two gates. Without it,
    // `failedGates = [firstFailure]` is indistinguishable from the correct implementation.
    id: 'D10',
    source: 'gate-expectation-grid',
    workflowVersion: 'a1b2c3d',
    sampleCount: 12,
    distinctContextKeyCount: 2,
    dominantOption: 'YES',
    dominancePercentage: 1.0,
    outcomeCoverage: 1.0,
    dominantOptionAttestedSuccessRate: 1.0,
    gates: cells({ G1_sample_count: FAIL, G2_context_diversity: FAIL }),
    verdict: 'SUPPRESSED',
    failedGates: ['G1_sample_count', 'G2_context_diversity'],
    counterexampleCount: 0,
  },
  {
    // The only row that takes the null path. G4 is N-A, never FAIL and never 0.0%; N-A is
    // not PASS, so the verdict is SUPPRESSED, and N-A never appears in `failedGates`.
    id: 'D11',
    source: 'gate-expectation-grid',
    workflowVersion: 'a1b2c3d',
    sampleCount: 40,
    distinctContextKeyCount: 8,
    dominantOption: 'YES',
    dominancePercentage: 0.95,
    outcomeCoverage: 0.0,
    dominantOptionAttestedSuccessRate: null,
    gates: cells({ G4_outcome_success: NA, G5_outcome_coverage: FAIL }),
    verdict: 'SUPPRESSED',
    failedGates: ['G5_outcome_coverage'],
    counterexampleCount: 0,
  },
];

/**
 * `Threshold boundary rows`, MVP_PLAN_V3 Phase 5.
 *
 * `B4-lo` is the only SUPPRESSED row in the set with a non-zero counterexample count, and
 * therefore the only fixture in the whole phase that catches an implementation which skips
 * counterexample collection once a verdict is suppressed.
 *
 * `B3-lo` discriminates G4's denominator: the dominant option's own attested rate is
 * 100.00% and PASSES, while the blend across both options is 89.90% and would FAIL.
 */
export const THRESHOLD_BOUNDARY_ROWS: readonly GridRow[] = [
  boundaryRow('B1-lo', 29, 8, 1.0, 1.0, 1.0, cells({ [G1]: FAIL }), 'SUPPRESSED', [G1], 0),
  boundaryRow('B1-at', 30, 8, 1.0, 1.0, 1.0, allPass, 'CANDIDATE', [], 0),
  boundaryRow('B1-hi', 31, 8, 1.0, 1.0, 1.0, allPass, 'CANDIDATE', [], 0),

  boundaryRow('B2-lo', 40, 4, 1.0, 1.0, 1.0, cells({ [G2]: FAIL }), 'SUPPRESSED', [G2], 0),
  boundaryRow('B2-at', 40, 5, 1.0, 1.0, 1.0, allPass, 'CANDIDATE', [], 0),
  boundaryRow('B2-hi', 40, 6, 1.0, 1.0, 1.0, allPass, 'CANDIDATE', [], 0),

  boundaryRow('B3-lo', 1000, 8, 0.899, 1.0, 1.0, cells({ [G3]: FAIL }), 'SUPPRESSED', [G3], 0),
  boundaryRow('B3-at', 1000, 8, 0.9, 1.0, 1.0, allPass, 'CANDIDATE', [], 0),
  boundaryRow('B3-hi', 1000, 8, 0.901, 1.0, 1.0, allPass, 'CANDIDATE', [], 0),

  boundaryRow('B4-lo', 1000, 8, 1.0, 1.0, 0.899, cells({ [G4]: FAIL }), 'SUPPRESSED', [G4], 101),
  boundaryRow('B4-at', 1000, 8, 1.0, 1.0, 0.9, allPass, 'CANDIDATE', [], 100),
  boundaryRow('B4-hi', 1000, 8, 1.0, 1.0, 0.901, allPass, 'CANDIDATE', [], 99),

  boundaryRow('B5-lo', 1000, 8, 1.0, 0.799, 1.0, cells({ [G5]: FAIL }), 'SUPPRESSED', [G5], 0),
  boundaryRow('B5-at', 1000, 8, 1.0, 0.8, 1.0, allPass, 'CANDIDATE', [], 0),
  boundaryRow('B5-hi', 1000, 8, 1.0, 0.801, 1.0, allPass, 'CANDIDATE', [], 0),
];

/**
 * Build one boundary row. Every column is TRANSCRIBED, including `Verdict` and
 * `failedGates`, even though both are mechanically implied by the gate cells. Deriving them
 * would make a mis-transcribed gate cell propagate silently into the two columns that could
 * otherwise contradict it; `expectations-table.spec.ts` cross-checks the three against each
 * other precisely because they were written down independently.
 */
function boundaryRow(
  id: string,
  sampleCount: number,
  distinctContextKeyCount: number,
  dominancePercentage: number,
  outcomeCoverage: number,
  dominantOptionAttestedSuccessRate: number,
  gates: GateCells,
  verdict: Verdict,
  failedGates: readonly GateId[],
  counterexampleCount: number,
): GridRow {
  return {
    id,
    source: 'threshold-boundary-rows',
    workflowVersion: 'v1',
    sampleCount,
    distinctContextKeyCount,
    dominantOption: 'YES',
    dominancePercentage,
    outcomeCoverage,
    dominantOptionAttestedSuccessRate,
    gates,
    verdict,
    failedGates,
    counterexampleCount,
  };
}

/** Every expectation row from both tables. */
export const ALL_GRID_ROWS: readonly GridRow[] = [
  ...GATE_EXPECTATION_GRID,
  ...THRESHOLD_BOUNDARY_ROWS,
];

/** `D8` needs its version to be identified; every other row's id is already unique. */
export const rowKey = (row: GridRow): string => `${row.id}@${row.workflowVersion}`;

/** Look a row up by key, failing loudly rather than returning `undefined`. */
export function gridRow(id: string, workflowVersion?: string): GridRow {
  const matches = ALL_GRID_ROWS.filter(
    (row) =>
      row.id === id && (workflowVersion === undefined || row.workflowVersion === workflowVersion),
  );
  const only = matches[0];
  if (only === undefined) throw new Error(`no grid row for "${id}"`);
  if (matches.length > 1) throw new Error(`"${id}" is split across versions; pass one`);
  return only;
}

// ---------------------------------------------------------------------------------------
// R fixtures — no gates apply.
// ---------------------------------------------------------------------------------------

/** One expected §20.2 emission. Mirrors `RepeatedFailedAction` without importing it. */
export interface ExpectedEmission {
  readonly runId: string;
  readonly toolName: string;
  readonly inputFingerprint: string;
  readonly attemptCount: number;
  /** The failing attempts IN ORDER — the evidence, never summarized. */
  readonly toolCallIds: readonly string[];
}

export interface RepeatedFailureRow {
  readonly id: 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
  /** The plan's `Expected` column, verbatim. */
  readonly expectation: string;
  /** Empty means silent. §20.2 has no suppression mechanism, so silence is the whole claim. */
  readonly emissions: readonly ExpectedEmission[];
}

/**
 * `R fixtures — no gates apply`, MVP_PLAN_V3 Phase 5.
 *
 * `R4` and `R5` both EMIT. `R1`-`R3` are silent, and if they were the whole corpus then
 * `return []` would satisfy it.
 */
export const REPEATED_FAILURE_EXPECTATIONS: readonly RepeatedFailureRow[] = [
  { id: 'R1', expectation: 'silent — no failure at all', emissions: [] },
  { id: 'R2', expectation: 'silent — below threshold', emissions: [] },
  { id: 'R3', expectation: 'silent — progress, not a loop', emissions: [] },
  {
    id: 'R4',
    expectation: 'EMIT — one recommendation',
    emissions: [
      {
        runId: 'run_R4',
        toolName: 'run_tests',
        inputFingerprint: 'fp_R4_a',
        attemptCount: 3,
        toolCallIds: ['tc_R4_1', 'tc_R4_2', 'tc_R4_3'],
      },
    ],
  },
  {
    id: 'R5',
    expectation: 'EMIT — the streak is per-target',
    emissions: [
      {
        runId: 'run_R5',
        toolName: 'run_tests',
        inputFingerprint: 'fp_R5_a',
        attemptCount: 3,
        // `tc_R5_3` is the unrelated tool B's SUCCESS. It is not part of this streak and
        // must not appear in the evidence — including it is the whole-timeline reading
        // leaking into the emission.
        toolCallIds: ['tc_R5_1', 'tc_R5_2', 'tc_R5_4'],
      },
    ],
  },
];

/** Look a repeated-failure expectation up by id, failing loudly. */
export function repeatedFailureRow(id: string): RepeatedFailureRow {
  const found = REPEATED_FAILURE_EXPECTATIONS.find((row) => row.id === id);
  if (found === undefined) throw new Error(`no repeated-failure expectation for "${id}"`);
  return found;
}
