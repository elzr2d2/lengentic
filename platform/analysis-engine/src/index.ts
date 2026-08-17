/**
 * Public entry point for `@lengentic/analysis-engine`.
 *
 * Wave 1 landed the graduated vocabulary. Wave 3 (`p5.det-candidate`) adds the first
 * runtime behaviour: §18 aggregation and §19 gate evaluation, both pure functions over
 * `DecisionRecord[]`. `platform/analysis-engine/src/candidate.ts` (§21 rendering) and the
 * §20.2 repeated-failed-action analyzer are `p5.repeated-failed`'s and 5b's, respectively.
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
export {
  aggregateAll,
  aggregateGroup,
  groupKeyOf,
  isEligible,
  serializeGroupKey,
} from './aggregate';
export { evaluateGates } from './gates';
