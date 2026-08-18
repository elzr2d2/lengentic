/**
 * Meta-tests on the expectation TABLE itself — is the transcription complete and internally
 * consistent, before any analyzer exists to be measured against it.
 *
 * A comparator can only be as good as the table it reads. A row with a gate cell nobody
 * filled in, a SUPPRESSED verdict naming no gate, or a `failedGates` list that disagrees
 * with its own cells would produce a confident green in wave 3 while asserting nothing.
 *
 * `verdict`, `failedGates` and the gate cells were all transcribed independently from the
 * plan's tables precisely so these cross-checks can catch a slip in any one of them.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_GRID_ROWS,
  GATE_EXPECTATION_GRID,
  GRID_GATE_ORDER,
  REPEATED_FAILURE_EXPECTATIONS,
  THRESHOLD_BOUNDARY_ROWS,
  rowKey,
} from '../../fixtures/expectations';

describe('the expectation table is complete', () => {
  it('carries every fixture of the gate expectation grid, D8 twice', () => {
    expect(GATE_EXPECTATION_GRID.map(rowKey)).toStrictEqual([
      'D1@a1b2c3d',
      'D2@a1b2c3d',
      'D3@a1b2c3d',
      'D4@a1b2c3d',
      'D5@a1b2c3d',
      'D6@a1b2c3d',
      'D7@a1b2c3d',
      'D8@a1b2c3d',
      'D8@e4f5a6b',
      'D9@a1b2c3d',
      'D10@a1b2c3d',
      'D11@a1b2c3d',
    ]);
  });

  it('carries all fifteen threshold boundary groups', () => {
    expect(THRESHOLD_BOUNDARY_ROWS.map((row) => row.id)).toStrictEqual([
      'B1-lo',
      'B1-at',
      'B1-hi',
      'B2-lo',
      'B2-at',
      'B2-hi',
      'B3-lo',
      'B3-at',
      'B3-hi',
      'B4-lo',
      'B4-at',
      'B4-hi',
      'B5-lo',
      'B5-at',
      'B5-hi',
    ]);
  });

  it('has no duplicate row key', () => {
    const keys = ALL_GRID_ROWS.map(rowKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('populates all five gate cells on every row', () => {
    const incomplete = ALL_GRID_ROWS.filter((row) =>
      GRID_GATE_ORDER.some((gate) => row.gates[gate] === undefined),
    );
    expect(incomplete.map(rowKey)).toStrictEqual([]);
  });
});

describe('every row is internally consistent', () => {
  it('names in failedGates exactly the gates whose cell is FAIL', () => {
    const disagreeing = ALL_GRID_ROWS.filter((row) => {
      const fromCells = GRID_GATE_ORDER.filter((gate) => row.gates[gate] === 'FAIL');
      return [...fromCells].sort().join(',') !== [...row.failedGates].sort().join(',');
    });
    expect(disagreeing.map(rowKey)).toStrictEqual([]);
  });

  it('never lists a NOT_APPLICABLE gate in failedGates', () => {
    const leaking = ALL_GRID_ROWS.filter((row) =>
      row.failedGates.some((gate) => row.gates[gate] === 'NOT_APPLICABLE'),
    );
    expect(leaking.map(rowKey)).toStrictEqual([]);
  });

  it('marks every SUPPRESSED row with at least one failing gate', () => {
    const silent = ALL_GRID_ROWS.filter(
      (row) => row.verdict === 'SUPPRESSED' && row.failedGates.length === 0,
    );
    expect(silent.map(rowKey)).toStrictEqual([]);
  });

  it('marks every CANDIDATE row with no failing gate and five PASS cells', () => {
    const wrong = ALL_GRID_ROWS.filter(
      (row) =>
        row.verdict === 'CANDIDATE' &&
        (row.failedGates.length > 0 || GRID_GATE_ORDER.some((gate) => row.gates[gate] !== 'PASS')),
    );
    expect(wrong.map(rowKey)).toStrictEqual([]);
  });

  it('sets dominantOptionAttestedSuccessRate to null exactly where G4 is N-A', () => {
    const wrong = ALL_GRID_ROWS.filter(
      (row) =>
        (row.gates.G4_outcome_success === 'NOT_APPLICABLE') !==
        (row.dominantOptionAttestedSuccessRate === null),
    );
    expect(wrong.map(rowKey)).toStrictEqual([]);
  });

  it('stores every percentage as a ratio in 0..1, never scaled by 100', () => {
    const outOfRange = ALL_GRID_ROWS.filter((row) => {
      const rates = [row.dominancePercentage, row.outcomeCoverage];
      if (row.dominantOptionAttestedSuccessRate !== null) {
        rates.push(row.dominantOptionAttestedSuccessRate);
      }
      return rates.some((rate) => rate < 0 || rate > 1);
    });
    expect(outOfRange.map(rowKey)).toStrictEqual([]);
  });
});

describe('the table binds what the Definition of Done claims it binds', () => {
  it('D10 is the only row that fails two gates at once — the failedGates discriminator', () => {
    const multi = ALL_GRID_ROWS.filter((row) => row.failedGates.length > 1);
    expect(multi.map(rowKey)).toStrictEqual(['D10@a1b2c3d']);
  });

  it('D11 is the only row taking the null path — G4 N-A, never FAIL, never 0', () => {
    const na = ALL_GRID_ROWS.filter((row) => row.dominantOptionAttestedSuccessRate === null);
    expect(na.map(rowKey)).toStrictEqual(['D11@a1b2c3d']);
    expect(na[0]?.gates.G4_outcome_success).toBe('NOT_APPLICABLE');
    expect(na[0]?.failedGates).toStrictEqual(['G5_outcome_coverage']);
  });

  it('B4-lo is the only SUPPRESSED row with counterexamples to collect', () => {
    const suppressedWithEvidence = ALL_GRID_ROWS.filter(
      (row) => row.verdict === 'SUPPRESSED' && row.counterexampleCount > 0,
    );
    expect(
      suppressedWithEvidence.filter((row) => row.source === 'threshold-boundary-rows').map(rowKey),
    ).toStrictEqual(['B4-lo@v1']);
  });

  it('B3-lo separates the dominant-specific success rate from the blended one', () => {
    const b3lo = THRESHOLD_BOUNDARY_ROWS.find((row) => row.id === 'B3-lo');
    // Dominant-only: 899 YES successes over 899 attested YES rows. Blended: 899 successes
    // over 1000 attested rows, which is the dominance figure and would FAIL G4.
    expect(b3lo?.dominantOptionAttestedSuccessRate).toBe(1.0);
    expect(b3lo?.dominancePercentage).toBe(0.899);
    expect(b3lo?.gates.G4_outcome_success).toBe('PASS');
    expect(b3lo?.gates.G3_dominance).toBe('FAIL');
  });

  it('places each boundary trio one unit either side of its threshold', () => {
    const value = (
      id: string,
      pick: 'samples' | 'contexts' | 'dominance' | 'success' | 'coverage',
    ) => {
      const row = THRESHOLD_BOUNDARY_ROWS.find((candidate) => candidate.id === id);
      if (row === undefined) throw new Error(`missing boundary row ${id}`);
      if (pick === 'samples') return row.sampleCount;
      if (pick === 'contexts') return row.distinctContextKeyCount;
      if (pick === 'dominance') return row.dominancePercentage;
      if (pick === 'coverage') return row.outcomeCoverage;
      return row.dominantOptionAttestedSuccessRate;
    };
    expect([
      value('B1-lo', 'samples'),
      value('B1-at', 'samples'),
      value('B1-hi', 'samples'),
    ]).toStrictEqual([29, 30, 31]);
    expect([
      value('B2-lo', 'contexts'),
      value('B2-at', 'contexts'),
      value('B2-hi', 'contexts'),
    ]).toStrictEqual([4, 5, 6]);
    expect([
      value('B3-lo', 'dominance'),
      value('B3-at', 'dominance'),
      value('B3-hi', 'dominance'),
    ]).toStrictEqual([0.899, 0.9, 0.901]);
    expect([
      value('B4-lo', 'success'),
      value('B4-at', 'success'),
      value('B4-hi', 'success'),
    ]).toStrictEqual([0.899, 0.9, 0.901]);
    expect([
      value('B5-lo', 'coverage'),
      value('B5-at', 'coverage'),
      value('B5-hi', 'coverage'),
    ]).toStrictEqual([0.799, 0.8, 0.801]);
  });

  it('flips exactly one verdict per boundary trio, so a one-unit shift cannot be a no-op', () => {
    const verdicts = (prefix: string) =>
      ['lo', 'at', 'hi'].map(
        (suffix) =>
          THRESHOLD_BOUNDARY_ROWS.find((row) => row.id === `${prefix}-${suffix}`)?.verdict,
      );
    for (const prefix of ['B1', 'B2', 'B3', 'B4', 'B5']) {
      expect(verdicts(prefix)).toStrictEqual(['SUPPRESSED', 'CANDIDATE', 'CANDIDATE']);
    }
  });
});

describe('the R expectations', () => {
  it('cover R1 through R5 exactly once each', () => {
    expect(REPEATED_FAILURE_EXPECTATIONS.map((row) => row.id)).toStrictEqual([
      'R1',
      'R2',
      'R3',
      'R4',
      'R5',
    ]);
  });

  it('expect an emission from R4 and R5 only — R1-R3 are the silent ones', () => {
    const emitting = REPEATED_FAILURE_EXPECTATIONS.filter((row) => row.emissions.length > 0);
    expect(emitting.map((row) => row.id)).toStrictEqual(['R4', 'R5']);
  });

  it('give every emission at least three attempts, per §20.2', () => {
    const short = REPEATED_FAILURE_EXPECTATIONS.flatMap((row) =>
      row.emissions.filter((emission) => emission.attemptCount < 3).map(() => row.id),
    );
    expect(short).toStrictEqual([]);
  });

  it('keep attemptCount equal to the number of cited toolCallIds', () => {
    const inconsistent = REPEATED_FAILURE_EXPECTATIONS.flatMap((row) =>
      row.emissions
        .filter((emission) => emission.attemptCount !== emission.toolCallIds.length)
        .map(() => row.id),
    );
    expect(inconsistent).toStrictEqual([]);
  });

  it('excludes the interleaved success from R5’s evidence', () => {
    const r5 = REPEATED_FAILURE_EXPECTATIONS.find((row) => row.id === 'R5');
    expect(r5?.emissions[0]?.toolCallIds).toStrictEqual(['tc_R5_1', 'tc_R5_2', 'tc_R5_4']);
  });
});
