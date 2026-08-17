import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, GATE_IDS } from '../../src/index';

/**
 * Transcription check of §19 against the public entry. Expected values are literals taken
 * from the plan, not read off the implementation — the two can therefore disagree. A
 * threshold typo or misspelled gate id here would propagate into wave 2's expectation
 * table and wave 3's implementation, at which point all three would agree with each other
 * while disagreeing with §19: a green that lies with a three-packet blast radius.
 */
describe('public entry contract (§19)', () => {
  it('DEFAULT_CONFIG matches the §19 thresholds exactly', () => {
    expect(DEFAULT_CONFIG).toStrictEqual({
      minSampleCount: 30,
      minDistinctContexts: 5,
      dominanceThreshold: 0.9,
      successThreshold: 0.9,
      coverageThreshold: 0.8,
    });
  });

  it('DEFAULT_CONFIG is frozen', () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
  });

  it('GATE_IDS is exactly G1..G5 in report order, with no duplicates', () => {
    expect(GATE_IDS).toStrictEqual([
      'G1_sample_count',
      'G2_context_diversity',
      'G3_dominance',
      'G4_outcome_success',
      'G5_outcome_coverage',
    ]);
    expect(new Set(GATE_IDS).size).toBe(5);
  });
});
