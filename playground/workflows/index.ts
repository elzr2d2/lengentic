/**
 * Public entry for `playground/workflows`. `playground/**` and its tests import from here,
 * never `./execution-strategy` directly — the same one-entry-per-directory idiom
 * `playground/index.ts`, `playground/providers`, `playground/determinism`,
 * `playground/strategy` and `playground/agents` each already set.
 */
export {
  buildExecutionStrategyDecision,
  buildExecutionStrategyRawContext,
  computeExecutionStrategyContextKey,
  EXECUTION_STRATEGY_AVAILABLE_OPTIONS,
  EXECUTION_STRATEGY_CONTEXT_KEY_VERSION,
  EXECUTION_STRATEGY_DECISION_TYPE,
} from './execution-strategy';
export type {
  ExecutionStrategyDecisionPayload,
  ExecutionStrategyEvaluation,
  ExecutionStrategyRawContext,
} from './execution-strategy';
