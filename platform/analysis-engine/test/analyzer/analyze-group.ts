/**
 * Shared test-only helper: declared fixture group -> analyzed group.
 *
 * Not a `.spec.ts` — vitest's `include` is `test/**\/*.spec.ts`, so this file is imported by
 * the specs in this directory and never collected as a suite of its own.
 */
import { aggregateAll, evaluateGates } from '../../src/index';
import type { AnalyzerConfig } from '../../src/index';
import type { AnalyzedGroup } from '../grid/assert-against-grid';
import { expandDecisionGroup, groupById } from '../../fixtures';
import type { DecisionGroupSpec } from '../../fixtures';

/**
 * Look a declared group up by id, expand it, and run §18 aggregation followed by §19 gate
 * evaluation. Uses `aggregateAll` rather than a single `aggregateGroup` call so that a
 * fixture whose decisions span more than one `workflowVersion` (D8) is grouped exactly the
 * way §18 requires — split, not merged — and `workflowVersion` picks the resulting group.
 */
export function analyzeGroup(
  groups: readonly DecisionGroupSpec[],
  id: string,
  config: AnalyzerConfig,
  workflowVersion?: string,
): AnalyzedGroup {
  const records = expandDecisionGroup(groupById(groups, id));
  const aggregates = aggregateAll(records);
  const aggregate =
    workflowVersion === undefined
      ? aggregates[0]
      : aggregates.find((a) => a.key.workflowVersion === workflowVersion);
  if (aggregate === undefined) {
    throw new Error(`analyzeGroup: no group "${id}" (workflowVersion ${String(workflowVersion)})`);
  }
  if (workflowVersion === undefined && aggregates.length > 1) {
    throw new Error(
      `analyzeGroup: "${id}" split into ${aggregates.length} groups — pass workflowVersion`,
    );
  }
  const evaluation = evaluateGates(aggregate, config);
  return { aggregate, evaluation };
}
