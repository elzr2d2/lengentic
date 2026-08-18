/**
 * The Phase 5a fixture corpus — inputs and the two expectation grids.
 *
 * Wave 3 (`p5.det-candidate`, `p5.repeated-failed`) imports from here, supplies `actual`,
 * and owns no `expect` call about analyzer behaviour of its own. `fixtures/**` and
 * `test/grid/**` are outside those packets' `allowed_paths`, so an analyzer packet
 * physically cannot relax an expectation to make its own code pass.
 */
export type { DecisionGroupSpec, DecisionSpec } from './inputs/expand';
export { expandDecisionGroup, groupById } from './inputs/expand';
export { DECISION_GROUPS } from './inputs/decision-groups';
export { BOUNDARY_GROUPS } from './inputs/boundary-groups';
export type { ToolCallFixture } from './inputs/tool-call-runs';
export { TOOL_CALL_FIXTURES, toolCallFixtureById } from './inputs/tool-call-runs';
export type { GateCells, GridRow, ExpectedEmission, RepeatedFailureRow } from './expectations';
export {
  ALL_GRID_ROWS,
  GATE_EXPECTATION_GRID,
  GRID_GATE_ORDER,
  REPEATED_FAILURE_EXPECTATIONS,
  THRESHOLD_BOUNDARY_ROWS,
  gridRow,
  repeatedFailureRow,
  rowKey,
} from './expectations';
