/**
 * §18 aggregation + §19 gate evaluation against the whole Phase 5a grid, under
 * `DEFAULT_CONFIG`.
 *
 * This file asserts NOTHING of its own about analyzer behaviour. Every expectation comes
 * from `assertAgainstGrid()` (`test/grid/**`, owned by `p5.negative-fixtures`) against
 * `ALL_GRID_ROWS` (`fixtures/**`, same owner) — this packet supplies `actual` only, and
 * `fixtures/**` / `test/grid/**` are outside its `allowed_paths`, so it cannot relax an
 * expectation to make its own code pass.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/index';
import { ALL_GRID_ROWS, BOUNDARY_GROUPS, DECISION_GROUPS } from '../../fixtures';
import type { GridRow } from '../../fixtures';
import { assertAgainstGrid } from '../grid/assert-against-grid';
import { analyzeGroup } from './analyze-group';

/** D8 occupies two grid rows, split by `workflowVersion`; every other id is unique. */
function analyze(row: GridRow) {
  const groups = row.source === 'gate-expectation-grid' ? DECISION_GROUPS : BOUNDARY_GROUPS;
  return analyzeGroup(groups, row.id, DEFAULT_CONFIG, row.workflowVersion);
}

describe('deterministic candidate analyzer — gate expectation grid (D1-D11)', () => {
  const rows = ALL_GRID_ROWS.filter((row) => row.source === 'gate-expectation-grid');

  it('covers all twelve D-fixture rows (D8 splits into two)', () => {
    expect(rows.length).toBe(12);
  });

  for (const row of rows) {
    it(`${row.id}@${row.workflowVersion}: ${row.verdict}`, () => {
      expect(() => assertAgainstGrid(analyze(row), row)).not.toThrow();
    });
  }
});

describe('deterministic candidate analyzer — threshold boundary rows (B1-B5), default config', () => {
  const rows = ALL_GRID_ROWS.filter((row) => row.source === 'threshold-boundary-rows');

  it('covers all fifteen boundary rows', () => {
    expect(rows.length).toBe(15);
  });

  for (const row of rows) {
    it(`${row.id}: ${row.verdict}`, () => {
      expect(() => assertAgainstGrid(analyze(row), row)).not.toThrow();
    });
  }
});
