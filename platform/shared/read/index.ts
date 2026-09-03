/**
 * The read model — the vocabulary of API *responses*, kept apart from `../schema/**`, which
 * is the ingestion wire contract.
 *
 * The split is the point, not tidiness. `schema/status.ts` freezes the STORED run statuses
 * and must never gain `STALE` (`MVP_PLAN_V3.md:592`, ADR 0005 decision 4 — derived at read
 * time, never written to a row). Two vocabularies in one module become one vocabulary, and
 * then something persists `STALE`.
 *
 * Exposed as the `@lengentic/shared/read` subpath. The root entry stays ingestion-only
 * because `platform/telemetry-sdk` imports it.
 */
export {
  RUN_VIEW_STATUSES,
  RunViewStatusSchema,
  OUTCOME_ATTESTED_BY,
  OutcomeAttestedBySchema,
  StepViewSchema,
  DecisionViewSchema,
  ModelCallViewSchema,
  ToolCallViewSchema,
  ErrorViewSchema,
  RunSummaryViewSchema,
  RunDetailViewSchema,
  RunListViewSchema,
  RunsListQuerySchema,
  RUNS_LIST_DEFAULT_LIMIT,
  RUNS_LIST_MAX_LIMIT,
  RunSummaryDropCountSchema,
} from './run-view';
export type {
  RunViewStatus,
  OutcomeAttestedBy,
  StepView,
  DecisionView,
  ModelCallView,
  ToolCallView,
  ErrorView,
  RunSummaryView,
  RunDetailView,
  RunListView,
  RunsListQuery,
  RunSummaryDropCount,
} from './run-view';
