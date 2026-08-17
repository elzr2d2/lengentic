/**
 * Public entry point for `@lengentic/analysis-engine`.
 *
 * Wave 1 exports the graduated vocabulary only: two runtime exports (`GATE_IDS`,
 * `DEFAULT_CONFIG`), zero functions. Aggregation and gate evaluation land in wave 3.
 */
export type {
  Outcome,
  OutcomeAttestedBy,
  DecisionRecord,
  GroupKey,
  ExclusionCounts,
  OptionCount,
  Counterexample,
  ContextConcentration,
  DecisionAggregate,
} from './types';
export type { ToolCallOutcome, ToolCallRecord, RepeatedFailedAction } from './tool-call';
export type { GateId, GateStatus, Verdict, GateResult, GateEvaluation } from './gate-contract';
export { GATE_IDS } from './gate-contract';
export type { AnalyzerConfig } from './config';
export { DEFAULT_CONFIG } from './config';
