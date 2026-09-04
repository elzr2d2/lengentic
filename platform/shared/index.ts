export {
  TELEMETRY_EVENT_TYPES,
  TELEMETRY_EVENT_TYPE_MIN_SCHEMA_VERSION,
  TelemetryEventTypeSchema,
  eventTypeAvailableAt,
} from './schema/event-type';
export type { TelemetryEventType } from './schema/event-type';

export {
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_SCHEMA_VERSIONS,
  TelemetrySchemaVersionSchema,
  schemaVersionAtLeast,
} from './schema/schema-version';
export type { TelemetrySchemaVersion } from './schema/schema-version';

export { TelemetryEventEnvelopeSchema } from './schema/envelope';
export type { TelemetryEventEnvelope } from './schema/envelope';

export {
  RUN_STATUSES,
  TERMINAL_STATUSES,
  RunStatusSchema,
  TerminalStatusSchema,
} from './schema/status';
export type { RunStatus, StepStatus, TerminalStatus } from './schema/status';

export { RunStartedPayloadSchema, RunCompletedPayloadSchema } from './schema/run-events';
export type { RunStartedPayload, RunCompletedPayload } from './schema/run-events';
export { StepStartedPayloadSchema, StepCompletedPayloadSchema } from './schema/step-events';
export type { StepStartedPayload, StepCompletedPayload } from './schema/step-events';

export {
  DECISION_OUTCOMES,
  DecisionOutcomeSchema,
  DecisionRecordedPayloadSchema,
  DecisionOutcomeAttestedPayloadSchema,
} from './schema/decision-events';
export type {
  DecisionOutcome,
  DecisionRecordedPayload,
  DecisionOutcomeAttestedPayload,
} from './schema/decision-events';

export { ModelCallRecordedPayloadSchema } from './schema/model-call-events';
export type { ModelCallRecordedPayload } from './schema/model-call-events';
export { ToolCallRecordedPayloadSchema } from './schema/tool-call-events';
export type { ToolCallRecordedPayload } from './schema/tool-call-events';
export { ErrorRecordedPayloadSchema } from './schema/error-events';
export type { ErrorRecordedPayload } from './schema/error-events';

export { TELEMETRY_PAYLOAD_SCHEMAS } from './schema/registry';
export type { TelemetryEvent, TelemetryEventOf } from './schema/registry';

export { INGEST_LIMITS } from './schema/limits';
export {
  TELEMETRY_INGEST_PATH,
  INGEST_ERROR_CODES,
  EVENT_LEVEL_ERROR_CODES,
  REQUEST_ERROR_CODES,
  IngestRequestSchema,
  IngestResponseSchema,
  IngestResultSchema,
  IngestResultErrorSchema,
  IngestResultStatusSchema,
} from './schema/ingest';
export type {
  IngestErrorCode,
  RequestErrorCode,
  IngestRequest,
  IngestResponse,
  IngestResult,
  IngestResultError,
  IngestResultStatus,
} from './schema/ingest';

export { parseTelemetryEvent } from './schema/parse';
export type { TelemetryEventParseResult } from './schema/parse';

export {
  IdSchema,
  NameSchema,
  TimestampSchema,
  MetadataSchema,
  MAX_ID_LENGTH,
  MAX_NAME_LENGTH,
} from './schema/primitives';
export type { Metadata } from './schema/primitives';

// The recommendation and analysis wire contract (§19/§21/§22). Exported from the root entry
// rather than from the `./read` subpath: `./read` is the *run* read model, and the 5b
// Definition of Done says `platform/shared/schema/recommendation.ts` must be "exported from
// the package's public entry". The SDK imports this entry and none of these symbols — they
// cost it nothing, because every one is either a type erased at compile time or a Zod
// schema tree-shaken out of a bundle that never names it.
export {
  GATE_IDS,
  GATE_STATUSES,
  VERDICTS,
  GateIdSchema,
  GateStatusSchema,
  VerdictSchema,
  GateResultSchema,
  GateResultsSchema,
  RECOMMENDATION_CATEGORIES,
  RECOMMENDATION_STATUSES,
  RecommendationCategorySchema,
  RecommendationStatusSchema,
  RecommendationOutcomeSchema,
  RecommendationGroupKeySchema,
  AnalyzerConfigSnapshotSchema,
  OptionCountSchema,
  ContextConcentrationSchema,
  CounterexampleSchema,
  ExclusionCountsSchema,
  RecommendationEvidenceSchema,
  SourceWatermarkSchema,
  FingerprintSchema,
  MAX_STATUS_NOTE_LENGTH,
  RecommendationSchema,
  RECOMMENDATIONS_LIST_DEFAULT_LIMIT,
  RECOMMENDATIONS_LIST_MAX_LIMIT,
  RecommendationsListQuerySchema,
  RecommendationListViewSchema,
  ANALYSIS_RUN_PATH,
  RECOMMENDATIONS_PATH,
  AnalysisRunRequestSchema,
  EvaluatedGroupSchema,
  AnalysisRunResponseSchema,
  RecommendationStatusPatchSchema,
} from './schema/recommendation';
export type {
  GateId,
  GateStatus,
  Verdict,
  GateResult,
  GateResults,
  RecommendationCategory,
  RecommendationStatus,
  RecommendationOutcome,
  RecommendationGroupKey,
  AnalyzerConfigSnapshot,
  OptionCount,
  ContextConcentration,
  Counterexample,
  ExclusionCounts,
  RecommendationEvidence,
  Recommendation,
  RecommendationsListQuery,
  RecommendationListView,
  EvaluatedGroup,
  AnalysisRunRequest,
  AnalysisRunResponse,
  RecommendationStatusPatch,
} from './schema/recommendation';
