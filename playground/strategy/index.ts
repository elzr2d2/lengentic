/**
 * Public entry for the execution-strategy evaluator. `playground/**` and its tests import
 * this module, never `./evaluator` or `./types` directly — one import site keeps the
 * internal split between rule logic and shape validation free to change.
 */
export { EVALUATOR_VERSION, evaluateExecutionStrategy } from './evaluator';
export type {
  AwarenessContext,
  EvaluateOptions,
  EvaluationResult,
  Limits,
  Mode,
  ReasonCode,
  Readiness,
  Resources,
  Risk,
  RiskLevel,
  Topology,
  TriBool,
} from './types';
