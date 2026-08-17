/**
 * Public entry point for `@lengentic/analysis-engine`.
 *
 * Wave 1 landed the graduated vocabulary. Wave 3 added the first two runtime behaviours:
 * `p5.det-candidate` — §18 aggregation and §19 gate evaluation, both pure functions over
 * `DecisionRecord[]` — and `p5.repeated-failed` — the §20.2 repeated-failed-action analyzer,
 * a pure function over `ToolCallRecord[]`. `platform/analysis-engine/src/candidate.ts` (§21
 * rendering) is 5b's.
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
export { detectRepeatedFailedActions } from './repeated-failed-action';
