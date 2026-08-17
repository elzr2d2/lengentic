/**
 * The threshold-binding spec — ADR `docs/decisions/0004`'s substitute for Tester at the
 * Phase 5a gate.
 *
 * PRE-DISPATCH AMENDMENT, why this file does not just re-run the D1-D11 grid under a
 * shifted config: every D fixture sits far from every threshold (sample counts 12, 24, 26,
 * 40, 45, 50, 50, 50, 60 and never 30; distinct contexts 2, 8, 8, 9, 10, 10, 11, 12, 15 and
 * never 5; no ratio 0.90 or 0.80). Shifting a threshold by one unit flips none of them, so a
 * spec built on D1-D11 would be green by construction and ADR 0004 would go unpaid. This
 * file uses the fifteen `B1`-`B5` boundary groups instead — `fixtures/inputs/boundary-groups
 * .ts`, owned by `p5.negative-fixtures` — each sitting one unit below, exactly on, or one
 * unit above the threshold its letter names.
 *
 * THE ACCEPTANCE CRITERION IS THAT THIS SPEC CAN FAIL, not that it exists. Flipping `>=` to
 * `>` in each of the five gate comparisons in `../../src/gates.ts` in turn must turn exactly
 * the corresponding assertions below red; see
 * `.artifacts/evidence/5a/threshold-binding-mutation.md` for the recorded run of that check.
 *
 * THE GENERIC RULE (stated with the `Threshold boundary rows` table): shift one threshold
 * one unit in one direction, and every group on the far side of the move flips while every
 * other group stays put.
 *
 *   - Shifting a threshold DOWN by one unit makes the gate easier to pass. The `-lo` group
 *     (one unit below default, currently the sole failing gate) flips FAIL -> PASS, and its
 *     verdict flips SUPPRESSED -> CANDIDATE. `-at` and `-hi` were already passing and stay
 *     passing.
 *   - Shifting a threshold UP by one unit makes the gate harder to pass. The `-at` group
 *     (exactly on the old default) flips PASS -> FAIL, and its verdict flips CANDIDATE ->
 *     SUPPRESSED. `-lo` was already failing and stays failing; `-hi` sits exactly on the new
 *     threshold (old default + unit = its own value) and stays passing.
 *   - Every group belonging to a DIFFERENT letter is untouched — a config is a plain object
 *     with five independent fields, and only one field changes per case — so it is checked
 *     with `assertAgainstGrid()` against its unmodified expectation.
 *
 * Only the ONE group that flips per case is asserted directly (no static grid row exists
 * for a shifted-threshold reading); the other fourteen are asserted through
 * `assertAgainstGrid()` against `fixtures/**`'s unmodified `THRESHOLD_BOUNDARY_ROWS`.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config';
import type { AnalyzerConfig } from '../../src/config';
import type { GateId } from '../../src/gate-contract';
import { BOUNDARY_GROUPS, gridRow } from '../../fixtures';
import { assertAgainstGrid } from '../grid/assert-against-grid';
import { analyzeGroup } from './analyze-group';

const ALL_BOUNDARY_IDS: readonly string[] = BOUNDARY_GROUPS.map((g) => g.id);

/** Ratio thresholds shift in 0.001 steps (the `B3`-`B5` groups sit 899/900/901 per 1000).
 *  Rounding to three decimal places keeps the shift off IEEE-754 noise — `0.9 - 0.001` is
 *  `0.8990000000000001` in a float and would silently fail the boundary group it exists to
 *  flip. */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

interface ThresholdShift {
  readonly gate: GateId;
  readonly field: keyof AnalyzerConfig;
  readonly unit: number;
  /** [-lo, -at, -hi] ids for this letter. */
  readonly ids: readonly [string, string, string];
}

const SHIFTS: readonly ThresholdShift[] = [
  { gate: 'G1_sample_count', field: 'minSampleCount', unit: 1, ids: ['B1-lo', 'B1-at', 'B1-hi'] },
  {
    gate: 'G2_context_diversity',
    field: 'minDistinctContexts',
    unit: 1,
    ids: ['B2-lo', 'B2-at', 'B2-hi'],
  },
  {
    gate: 'G3_dominance',
    field: 'dominanceThreshold',
    unit: 0.001,
    ids: ['B3-lo', 'B3-at', 'B3-hi'],
  },
  {
    gate: 'G4_outcome_success',
    field: 'successThreshold',
    unit: 0.001,
    ids: ['B4-lo', 'B4-at', 'B4-hi'],
  },
  {
    gate: 'G5_outcome_coverage',
    field: 'coverageThreshold',
    unit: 0.001,
    ids: ['B5-lo', 'B5-at', 'B5-hi'],
  },
];

function isRatioField(field: keyof AnalyzerConfig): boolean {
  return field !== 'minSampleCount' && field !== 'minDistinctContexts';
}

function shiftedConfig(shift: ThresholdShift, direction: 1 | -1): AnalyzerConfig {
  const raw = DEFAULT_CONFIG[shift.field] + direction * shift.unit;
  const value = isRatioField(shift.field) ? round3(raw) : raw;
  return Object.freeze({ ...DEFAULT_CONFIG, [shift.field]: value });
}

/** Every boundary group except the one that is expected to flip, checked unchanged. */
function assertUnaffected(exceptId: string, config: AnalyzerConfig): void {
  for (const id of ALL_BOUNDARY_IDS) {
    if (id === exceptId) continue;
    const row = gridRow(id);
    expect(() =>
      assertAgainstGrid(analyzeGroup(BOUNDARY_GROUPS, id, config, 'v1'), row),
    ).not.toThrow();
  }
}

describe('threshold-binding — every gate is bound by a boundary group that flips', () => {
  for (const shift of SHIFTS) {
    const [loId, atId, hiId] = shift.ids;

    it(`${shift.gate}: shifting ${shift.field} down by one unit flips ${loId} FAIL->PASS, SUPPRESSED->CANDIDATE`, () => {
      const config = shiftedConfig(shift, -1);
      const flipped = analyzeGroup(BOUNDARY_GROUPS, loId, config, 'v1');
      const gate = flipped.evaluation.gates.find((g) => g.id === shift.gate);
      expect(gate?.status).toBe('PASS');
      expect(flipped.evaluation.verdict).toBe('CANDIDATE');
      expect(flipped.evaluation.failedGates).not.toContain(shift.gate);

      assertUnaffected(loId, config);
    });

    it(`${shift.gate}: shifting ${shift.field} up by one unit flips ${atId} PASS->FAIL, CANDIDATE->SUPPRESSED`, () => {
      const config = shiftedConfig(shift, 1);
      const flipped = analyzeGroup(BOUNDARY_GROUPS, atId, config, 'v1');
      const gate = flipped.evaluation.gates.find((g) => g.id === shift.gate);
      expect(gate?.status).toBe('FAIL');
      expect(flipped.evaluation.verdict).toBe('SUPPRESSED');
      expect(flipped.evaluation.failedGates).toContain(shift.gate);

      assertUnaffected(atId, config);
    });

    it(`${shift.gate}: ${hiId} stays PASS/CANDIDATE under both shifts`, () => {
      for (const direction of [-1, 1] as const) {
        const config = shiftedConfig(shift, direction);
        const result = analyzeGroup(BOUNDARY_GROUPS, hiId, config, 'v1');
        const gate = result.evaluation.gates.find((g) => g.id === shift.gate);
        expect(gate?.status).toBe('PASS');
        expect(result.evaluation.verdict).toBe('CANDIDATE');
      }
    });

    it(`${shift.gate}: ${loId} stays FAIL/SUPPRESSED under an up-shift (moving further away)`, () => {
      const config = shiftedConfig(shift, 1);
      const result = analyzeGroup(BOUNDARY_GROUPS, loId, config, 'v1');
      const gate = result.evaluation.gates.find((g) => g.id === shift.gate);
      expect(gate?.status).toBe('FAIL');
      expect(result.evaluation.verdict).toBe('SUPPRESSED');
    });
  }
});
