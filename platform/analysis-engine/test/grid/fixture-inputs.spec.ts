/**
 * Meta-tests on the fixture INPUTS — do the declared shapes actually materialise into the
 * rows the expectation table says they do.
 *
 * SCOPE, deliberately narrow. This file counts records and counts distinct `contextKey`s
 * over the eligible set, and stops there. It does NOT compute dominance, coverage, success
 * rates or counterexamples. Re-deriving those here would put a second implementation of §18
 * in the test layer, and wave 3 could then be "verified" by agreeing with it — which is the
 * same provenance failure as sourcing an expectation from `src/`, one directory over.
 *
 * What it does catch is a transcription slip in an input block. Without it, a fixture whose
 * declared counts disagree with the grid turns up in wave 3 as an analyzer failure, and the
 * wave-3 Builder — who cannot edit these files — spends the packet on someone else's typo.
 */
import { describe, expect, it } from 'vitest';
import type { DecisionRecord } from '../../src/types';
import { BOUNDARY_GROUPS } from '../../fixtures/inputs/boundary-groups';
import { DECISION_GROUPS } from '../../fixtures/inputs/decision-groups';
import type { DecisionGroupSpec } from '../../fixtures/inputs/expand';
import { expandDecisionGroup, groupById } from '../../fixtures/inputs/expand';
import { TOOL_CALL_FIXTURES, toolCallFixtureById } from '../../fixtures/inputs/tool-call-runs';
import {
  GATE_EXPECTATION_GRID,
  THRESHOLD_BOUNDARY_ROWS,
  rowKey,
} from '../../fixtures/expectations';
import type { GridRow } from '../../fixtures/expectations';

/** §18: eligible = decisions after excluding STALE runs and null `contextKey`. */
const eligible = (records: readonly DecisionRecord[]): readonly DecisionRecord[] =>
  records.filter((record) => !record.runIsStale && record.contextKey !== null);

const distinctContexts = (records: readonly DecisionRecord[]): number =>
  new Set(records.map((record) => record.contextKey)).size;

function rowsFor(row: GridRow, groups: readonly DecisionGroupSpec[]): readonly DecisionRecord[] {
  const expanded = expandDecisionGroup(groupById(groups, row.id));
  return eligible(expanded).filter((record) => record.workflowVersion === row.workflowVersion);
}

describe('D1-D11 inputs materialise the sample and context counts the grid states', () => {
  for (const row of GATE_EXPECTATION_GRID) {
    it(`${rowKey(row)} expands to ${row.sampleCount} eligible rows over ${row.distinctContextKeyCount} contexts`, () => {
      const records = rowsFor(row, DECISION_GROUPS);
      expect(records.length).toBe(row.sampleCount);
      expect(distinctContexts(records)).toBe(row.distinctContextKeyCount);
    });
  }

  it('D5 hides its twelve eligible rows behind 20 stale and 5 null-contextKey rows', () => {
    const expanded = expandDecisionGroup(groupById(DECISION_GROUPS, 'D5'));
    expect(expanded.length).toBe(37);
    expect(expanded.filter((record) => record.runIsStale).length).toBe(20);
    expect(expanded.filter((record) => record.contextKey === null).length).toBe(5);
    // Raw count is 37, which would clear G1. The fixture only fails if exclusion fires.
    expect(eligible(expanded).length).toBe(12);
  });

  it('D8 splits into 26 and 24 across two workflowVersions, from 50 pooled rows', () => {
    const expanded = expandDecisionGroup(groupById(DECISION_GROUPS, 'D8'));
    expect(expanded.length).toBe(50);
    const versions = expanded.reduce<Record<string, number>>((tally, record) => {
      tally[record.workflowVersion] = (tally[record.workflowVersion] ?? 0) + 1;
      return tally;
    }, {});
    expect(versions).toStrictEqual({ a1b2c3d: 26, e4f5a6b: 24 });
  });

  it('D10 is under-sampled AND context-poor, so it fails G1 and G2 together', () => {
    const records = eligible(expandDecisionGroup(groupById(DECISION_GROUPS, 'D10')));
    expect(records.length).toBe(12);
    expect(distinctContexts(records)).toBe(2);
  });

  it('D11 attests nothing at all — every outcome UNKNOWN', () => {
    const records = eligible(expandDecisionGroup(groupById(DECISION_GROUPS, 'D11')));
    expect(records.length).toBe(40);
    expect(records.filter((record) => record.outcome !== 'UNKNOWN')).toStrictEqual([]);
    expect(new Set(records.map((record) => record.outcomeAttestedBy))).toStrictEqual(
      new Set(['UNKNOWN']),
    );
  });

  it('gives every D fixture its own decisionType, so no two groups can merge', () => {
    const types = DECISION_GROUPS.map((group) => group.decisionType);
    expect(new Set(types).size).toBe(types.length);
  });
});

describe('B1-B5 inputs materialise the boundary shapes the table states', () => {
  for (const row of THRESHOLD_BOUNDARY_ROWS) {
    it(`${row.id} expands to ${row.sampleCount} rows over ${row.distinctContextKeyCount} contexts`, () => {
      const records = rowsFor(row, BOUNDARY_GROUPS);
      expect(records.length).toBe(row.sampleCount);
      expect(distinctContexts(records)).toBe(row.distinctContextKeyCount);
    });
  }

  it('excludes nothing — no boundary group has a STALE run or a null contextKey', () => {
    const excluded = BOUNDARY_GROUPS.flatMap((group) =>
      expandDecisionGroup(group).filter(
        (record) => record.runIsStale || record.contextKey === null,
      ),
    );
    expect(excluded).toStrictEqual([]);
  });

  it('shares one group key across all fifteen, exactly as the plan states', () => {
    const keys = new Set(
      BOUNDARY_GROUPS.map(
        (group) =>
          `${group.workflowName}|${group.workflowVersion}|${group.decisionType}|${group.contextKeyVersion}`,
      ),
    );
    expect([...keys]).toStrictEqual(['boundary-wf|v1|boundary_decision|ckv1']);
  });

  it('assigns contexts round-robin from the pool’s first entry, in order', () => {
    const records = expandDecisionGroup(groupById(BOUNDARY_GROUPS, 'B1-lo'));
    expect(records.slice(0, 9).map((record) => record.contextKey)).toStrictEqual([
      'c1',
      'c2',
      'c3',
      'c4',
      'c5',
      'c6',
      'c7',
      'c8',
      'c1',
    ]);
  });
});

describe('R1-R5 inputs', () => {
  it('declare R1 through R5 exactly once each', () => {
    expect(TOOL_CALL_FIXTURES.map((fixture) => fixture.id)).toStrictEqual([
      'R1',
      'R2',
      'R3',
      'R4',
      'R5',
    ]);
  });

  it('R1 records ten identical actions and not one failure', () => {
    const calls = toolCallFixtureById('R1').calls;
    expect(calls.length).toBe(10);
    expect(
      calls.filter((call) => call.outcome !== 'SUCCESS' || call.errorType !== null),
    ).toStrictEqual([]);
    expect(new Set(calls.map((call) => `${call.toolName}|${call.inputFingerprint}`)).size).toBe(1);
  });

  it('R2 stops one attempt short of the threshold of three', () => {
    const calls = toolCallFixtureById('R2').calls;
    expect(calls.length).toBe(2);
    expect(calls.filter((call) => call.outcome !== 'FAILED')).toStrictEqual([]);
    expect(new Set(calls.map((call) => call.inputFingerprint)).size).toBe(1);
  });

  it('R3 fails four times against four different targets — progress, not a loop', () => {
    const calls = toolCallFixtureById('R3').calls;
    expect(calls.length).toBe(4);
    expect(calls.filter((call) => call.outcome !== 'FAILED')).toStrictEqual([]);
    expect(new Set(calls.map((call) => call.inputFingerprint)).size).toBe(4);
    expect(new Set(calls.map((call) => call.toolName)).size).toBe(1);
  });

  it('R4 fails three times in a row against one target in one run', () => {
    const calls = toolCallFixtureById('R4').calls;
    expect(calls.length).toBe(3);
    expect(calls.filter((call) => call.outcome !== 'FAILED')).toStrictEqual([]);
    expect(
      new Set(calls.map((call) => `${call.runId}|${call.toolName}|${call.inputFingerprint}`)).size,
    ).toBe(1);
  });

  it('R5 is pinned to F(A) F(A) S(B) F(A) in one run', () => {
    const calls = toolCallFixtureById('R5').calls;
    const timeline = [...calls]
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
      .map((call) => `${call.outcome === 'SUCCESS' ? 'S' : 'F'}(${call.inputFingerprint})`);
    expect(timeline).toStrictEqual(['F(fp_R5_a)', 'F(fp_R5_a)', 'S(fp_R5_b)', 'F(fp_R5_a)']);
    // Single run: put the success in a second run and the fixture stops discriminating.
    expect(new Set(calls.map((call) => call.runId))).toStrictEqual(new Set(['run_R5']));
    // The success belongs to an UNRELATED tool. Same tool would make it a different fixture.
    const success = calls.filter((call) => call.outcome === 'SUCCESS');
    expect(success.map((call) => call.toolName)).toStrictEqual(['lint_project']);
    expect(
      new Set(calls.filter((call) => call.outcome === 'FAILED').map((c) => c.toolName)),
    ).toStrictEqual(new Set(['run_tests']));
  });

  it('orders every fixture’s calls by a strictly increasing occurredAt', () => {
    for (const fixture of TOOL_CALL_FIXTURES) {
      const stamps = fixture.calls.map((call) => call.occurredAt);
      expect(stamps).toStrictEqual([...stamps].sort((left, right) => left.localeCompare(right)));
      expect(new Set(stamps).size).toBe(stamps.length);
    }
  });

  it('gives every tool call a unique id', () => {
    const ids = TOOL_CALL_FIXTURES.flatMap((fixture) =>
      fixture.calls.map((call) => call.toolCallId),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});
