/**
 * §20.2 repeated-failed-action analyzer against the R1-R5 fixture corpus.
 *
 * This file asserts NOTHING of its own about analyzer behaviour. Every expectation comes
 * from `assertRepeatedFailures()` (`test/grid/**`, owned by `p5.negative-fixtures`) against
 * `REPEATED_FAILURE_EXPECTATIONS` (`fixtures/**`, same owner) — this packet supplies
 * `actual` only, and `fixtures/**` / `test/grid/**` are outside its `allowed_paths`, so it
 * cannot relax an expectation to make its own code pass.
 *
 * R1-R3 (negative) run first: each expects silence, and `return []` alone would satisfy all
 * three. R4 proves the analyzer exists at all; R5 proves the streak is scoped to the
 * `(runId, toolName, inputFingerprint)` subsequence rather than the run's whole timeline. A
 * run where R4 or R5 does not emit is not this packet passing with a caveat.
 */
import { describe, expect, it } from 'vitest';
import { detectRepeatedFailedActions } from '../../src/index';
import { TOOL_CALL_FIXTURES, repeatedFailureRow } from '../../fixtures';
import { assertRepeatedFailures } from '../grid/assert-against-grid';

describe('repeated failed action analyzer — R1-R5 (§20.2)', () => {
  it('covers all five R fixtures', () => {
    expect(TOOL_CALL_FIXTURES.length).toBe(5);
  });

  for (const fixture of TOOL_CALL_FIXTURES) {
    it(`${fixture.id}: ${fixture.label}`, () => {
      const actual = detectRepeatedFailedActions(fixture.calls);
      expect(() => assertRepeatedFailures(actual, repeatedFailureRow(fixture.id))).not.toThrow();
    });
  }
});
