/**
 * Hand-built `actual` objects for the comparator's own meta-tests.
 *
 * Wave 2 has no analyzer to call — `src/aggregate.ts`, `src/gates.ts` and the two analyzer
 * modules land in wave 3 — so `assertAgainstGrid()` is proven against objects constructed
 * here from an expectation row. That is deliberate and it is not circular: `conforming()`
 * only establishes that the comparator ACCEPTS a matching object. Everything that makes the
 * comparator worth having is proven by mutating one field of a conforming object and
 * requiring a throw that names that field. A comparator nobody mutation-checked is the
 * green that lies this whole phase is about.
 *
 * Fields the grid does not have a column for (`key`, `optionDistribution`, `attestedCount`,
 * `minorityContextConcentration`, `excluded`) are filled with plausible values and are not
 * compared by anything.
 */
import type { Counterexample, DecisionAggregate } from '../../src/types';
import type { GateEvaluation } from '../../src/gate-contract';
import type { RepeatedFailedAction } from '../../src/tool-call';
import type { GridRow, RepeatedFailureRow } from '../../fixtures/expectations';
import { GRID_GATE_ORDER } from '../../fixtures/expectations';
import type { AnalyzedGroup } from './assert-against-grid';

const counterexamples = (count: number): readonly Counterexample[] =>
  Array.from({ length: count }, (_unused, index) => ({
    decisionId: `hand_built_ce_${index}`,
    runId: `hand_built_run_${index}`,
    contextKey: 'c1',
    selectedOption: 'NO',
    outcome: 'FAILURE' as const,
  }));

/** An `AnalyzedGroup` that matches `row` in every column the comparator reads. */
export function conforming(row: GridRow): AnalyzedGroup {
  return {
    aggregate: {
      key: {
        workflowName: 'hand-built',
        workflowVersion: row.workflowVersion,
        decisionType: 'hand_built_decision',
        contextKeyVersion: 'v1',
      },
      sampleCount: row.sampleCount,
      distinctContextKeyCount: row.distinctContextKeyCount,
      optionDistribution: [
        {
          option: row.dominantOption,
          count: Math.round(row.dominancePercentage * row.sampleCount),
          share: row.dominancePercentage,
        },
      ],
      dominantOption: row.dominantOption,
      dominancePercentage: row.dominancePercentage,
      attestedCount: Math.round(row.outcomeCoverage * row.sampleCount),
      outcomeCoverage: row.outcomeCoverage,
      dominantOptionAttestedSuccessRate: row.dominantOptionAttestedSuccessRate,
      counterexamples: counterexamples(row.counterexampleCount),
      minorityContextConcentration: [],
      excluded: { staleRun: 0, missingContextKey: 0 },
    },
    evaluation: {
      gates: GRID_GATE_ORDER.map((id) => ({
        id,
        status: row.gates[id],
        comparison: 'hand-built',
      })),
      failedGates: row.failedGates,
      verdict: row.verdict,
    },
  };
}

export const withAggregate = (
  group: AnalyzedGroup,
  patch: Partial<DecisionAggregate>,
): AnalyzedGroup => ({
  aggregate: { ...group.aggregate, ...patch },
  evaluation: group.evaluation,
});

export const withEvaluation = (
  group: AnalyzedGroup,
  patch: Partial<GateEvaluation>,
): AnalyzedGroup => ({
  aggregate: group.aggregate,
  evaluation: { ...group.evaluation, ...patch },
});

/** Rebuild the gate results with one cell overridden, keeping §19's report order. */
export function withGateStatus(
  group: AnalyzedGroup,
  id: string,
  status: GateEvaluation['gates'][number]['status'],
): AnalyzedGroup {
  return withEvaluation(group, {
    gates: group.evaluation.gates.map((gate) => (gate.id === id ? { ...gate, status } : gate)),
  });
}

/** Emissions that match `row` exactly. Empty for the silent fixtures. */
export const conformingEmissions = (row: RepeatedFailureRow): readonly RepeatedFailedAction[] =>
  row.emissions.map((emission) => ({
    runId: emission.runId,
    toolName: emission.toolName,
    inputFingerprint: emission.inputFingerprint,
    attemptCount: emission.attemptCount,
    toolCallIds: emission.toolCallIds,
  }));
