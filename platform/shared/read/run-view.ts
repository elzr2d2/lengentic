import { z } from 'zod';
import { RunStatusSchema } from '../schema/status';
import { DecisionOutcomeSchema } from '../schema/decision-events';
import { MetadataSchema, TimestampSchema } from '../schema/primitives';

/**
 * The **read model** for `GET /v1/runs` and `GET /v1/runs/:id`.
 *
 * Deliberately a separate vocabulary from `platform/shared/schema/**`, which is the
 * *ingestion* wire contract. `RUN_STATUSES` there is the STORED enum and must stay
 * `RUNNING | COMPLETED | FAILED` forever: `MVP_PLAN_V3.md:592` and
 * `docs/decisions/0005-phase-2-wire-contract-gaps.md` decision 4 make `STALE` derived at
 * read time and never written to a row. Widening the stored enum would make the two the
 * same object, and the next writer stores `STALE`.
 *
 * **Why it lives in `platform/shared/read/**` and not in the API.** Every response consumer
 * needs this vocabulary, and `check:boundaries` forbids the dashboard importing
 * `platform/api/src/**`. Left in the API it would be hand-declared a second time at each
 * consumer, and the twin would drift. It is reachable only through the `@lengentic/shared/read`
 * subpath, deliberately not through `@lengentic/shared`: the SDK imports the root entry, and
 * an ingestion-side author who can see `STALE` is one refactor away from storing it.
 *
 * Nothing here knows about Prisma, Nest or HTTP — it imports `zod` and this package's own
 * schema primitives, and nothing else.
 */

/**
 * The stored statuses plus `STALE`.
 *
 * Written out rather than spread from `RUN_STATUSES`, so that widening the stored enum is a
 * loud compile-and-test event here instead of a silent widening of the response. Both
 * directions of the relationship — every stored status is representable, and `STALE` never
 * leaks back into the stored enum — are asserted in `test/read/run-view.spec.ts`.
 */
export const RUN_VIEW_STATUSES = Object.freeze([
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'STALE',
] as const);

export type RunViewStatus = (typeof RUN_VIEW_STATUSES)[number];

export const RunViewStatusSchema = z.enum(RUN_VIEW_STATUSES);

/**
 * A Step reports its STORED status and never `STALE`.
 *
 * §13 defines the derivation as `now - lastEventAt > STALE_RUN_THRESHOLD`, and Step has no
 * `lastEventAt` column — `schema.prisma` states why: "liveness is a Run concept". Deriving a
 * step's staleness from its run's would report a per-step observation the system never made,
 * which is the counterfactual shape `CLAUDE.md` ## Product claims forbids elsewhere for the
 * same reason. A consumer that wants "this step belongs to a dead run" reads the run's own
 * `status`, which is right there in the same response.
 */
export const StepViewSchema = z.object({
  id: z.string(),
  runId: z.string(),
  /** `null` means root step — a deliberate signal, not a missing value (§13). */
  parentStepId: z.string().nullable(),
  /** Null until the `step.started` event lands; §12 permits completion-before-start. */
  name: z.string().nullable(),
  agentName: z.string().nullable(),
  type: z.string().nullable(),
  status: RunStatusSchema,
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  receivedAt: TimestampSchema,
  metadata: MetadataSchema.nullable(),
});

export const RunSummaryViewSchema = z.object({
  id: z.string(),
  traceId: z.string(),
  /** Null until the `run.started` event lands (`schema.prisma`, Run.workflowName). */
  workflowName: z.string().nullable(),
  workflowVersion: z.string().nullable(),
  /** The DERIVED status: `STALE` replaces `RUNNING` here, never in the row. ADR 0005 §4. */
  status: RunViewStatusSchema,
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  receivedAt: TimestampSchema,
  /**
   * Exposed because it is the sole input to `status`'s derivation. Without it a consumer
   * looking at `STALE` cannot tell how long the run has been silent, and cannot check the
   * server's arithmetic.
   */
  lastEventAt: TimestampSchema,
  metadata: MetadataSchema.nullable(),
});

/**
 * §14's attestation provenance, read side only.
 *
 * Deliberately absent from `schema/decision-events.ts`: the wire has no `outcomeAttestedBy`
 * field because the caller cannot choose it — the arrival of a `decision.outcome_attested`
 * event *is* the evidence that a caller attested, so the value is derived at the persistence
 * edge. A response must still report it, because `CLAUDE.md` ## Product claims requires every
 * surface to be able to say "attested success rate" and name who attested. `INFERRED` is not
 * a member here for the same reason §14 refuses it on the write side: no producer.
 */
export const OUTCOME_ATTESTED_BY = Object.freeze(['CALLER', 'UNKNOWN'] as const);

export type OutcomeAttestedBy = (typeof OUTCOME_ATTESTED_BY)[number];

export const OutcomeAttestedBySchema = z.enum(OUTCOME_ATTESTED_BY);

/**
 * A stored Decision, read back (§13, §14).
 *
 * Almost everything is nullable, and not because a *recorded* decision may omit it. §14
 * makes attestation "an independent, idempotent telemetry event" that may arrive for an
 * unknown `decisionId` — "accepted and stored, not rejected" — so a row can exist that only
 * an attestation ever wrote. Those rows have no `decisionType`, no options and no selection,
 * and the response has to be able to say so. The nullability mirrors the Prisma model
 * column for column, which records the same reasoning.
 *
 * `contextKey` is exposed rather than folded away because §14 makes it the caller's
 * obligation and the Run Explorer's Decisions view is required to show it: a null key means
 * this decision is stored but EXCLUDED from aggregation, and a reader who cannot see the
 * null cannot tell a decision that will never be grouped from one that will.
 *
 * `rawContext` is whatever survived §15's serialize → redact → cap order client-side. The
 * platform stores what it was sent; nothing here re-redacts, because redaction that happens
 * after transmission has already failed.
 */
export const DecisionViewSchema = z.object({
  id: z.string(),
  runId: z.string(),
  /** Null only on an attestation-first row — see the note above, not "optional on record". */
  stepId: z.string().nullable(),
  decisionType: z.string().nullable(),
  /** Null means: stored, and excluded from aggregation (§14). Never defaulted to a key. */
  contextKey: z.string().nullable(),
  contextKeyVersion: z.string().nullable(),
  rawContext: MetadataSchema.nullable(),
  availableOptions: z.array(z.string()).nullable(),
  selectedOption: z.string().nullable(),
  outcome: DecisionOutcomeSchema,
  outcomeAttestedBy: OutcomeAttestedBySchema,
  outcomeObservedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

/**
 * A stored ModelCall, read back (§13).
 *
 * Token counts stay `null` when the provider reported none rather than becoming `0`: §13
 * marks exactly those two fields optional, and a zero would read as "this call used no
 * tokens" — a measurement the platform never received. `RunSummary`'s
 * `modelCallsMissingInputTokens` exists for the same reason at the aggregate level.
 *
 * `status` is a free string, matching the wire and the column. An enum invented on the read
 * side would reject values ingestion already accepted, which is a response that cannot
 * report its own database.
 */
export const ModelCallViewSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: z.string(),
  provider: z.string(),
  model: z.string(),
  latencyMs: z.number().int(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  status: z.string(),
  metadata: MetadataSchema.nullable(),
  createdAt: TimestampSchema,
});

/**
 * A stored ToolCall, read back (§13, §15).
 *
 * The four truncation columns travel with the payload, never apart from it. §15's whole
 * point is that truncation must lose the payload and not the measurement, so a response
 * carrying `input` without `inputTruncated` / `inputBytes` would show a developer a complete
 * -looking tool input that is actually the first 32KB of one. The Run Explorer's Tool Calls
 * view is required to flag exactly this.
 *
 * `input` / `output` are `z.unknown()` and not `MetadataSchema`: a tool's payload is not
 * necessarily a JSON object — an array or a bare string is a legitimate tool shape, which is
 * the same call `tool-call-events.ts` makes on the wire.
 *
 * No `createdAt`: §13 gives ToolCall none and the column does not exist. `startedAt` and
 * `completedAt` are CLIENT clocks; `durationMs` is the client's own measurement and is not
 * recomputed here — §12 forbids combining the two clock families in one duration, and the
 * only server clock in this response is on the Run.
 *
 * `inputBytes` / `outputBytes` are `.nullable()` (Reviewer S3, Phase 4 phase gate repair
 * attempt 1): `null` is a call recorded with `captureToolIO: false` — nothing was measured —
 * distinct from a real, reported `0`. `run-telemetry.ts`'s `formatByteCount` already renders
 * `null` as `not reported`; before this the SDK could only send a manufactured `0`, and the
 * Dashboard rendered "0 bytes lost to truncation" for a run whose tool IO was never captured
 * at all — `CLAUDE.md` ## Product claims.
 */
export const ToolCallViewSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  output: z.unknown(),
  inputTruncated: z.boolean(),
  outputTruncated: z.boolean(),
  inputBytes: z.number().int().nullable(),
  outputBytes: z.number().int().nullable(),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  durationMs: z.number().int(),
  success: z.boolean(),
  /** Null on success. Unbounded — an error message is captured evidence (§13). */
  error: z.string().nullable(),
});

/**
 * A stored Error, read back (§13).
 *
 * An error the *instrumented system* reported as telemetry, not an ingestion rejection —
 * rejections are `INGEST_ERROR_CODES` on the ingest response and never become rows. A
 * consumer that showed these under a heading like "ingestion errors" would be reporting the
 * platform's health from the agent's failures.
 */
export const ErrorViewSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: z.string(),
  type: z.string(),
  message: z.string(),
  metadata: MetadataSchema.nullable(),
  createdAt: TimestampSchema,
});

/**
 * Steps arrive as a flat, deterministically ordered array carrying `parentStepId`.
 *
 * Not a server-built tree: a child whose parent has not arrived (§13 — no foreign key, and
 * "posting a child Step before its parent produces the correct tree" is a Phase 2 DoD line)
 * is an ordinary member of this array, and whether it renders nested or orphaned is one map
 * lookup at the consumer. Building the tree here would force the API to invent a placement
 * for a parent it has never seen.
 *
 * **The four Phase 4 collections are `.optional()`, and that is a load-bearing choice.**
 * `.default([])` was rejected: it would turn a response that never mentioned decisions into
 * "this run made no decisions", which is a claim the server did not make — the same
 * manufactured-absence failure `RunSummary.droppedTelemetryEventCount` refuses to commit by
 * reporting `null` instead of `0`. Required was rejected too, and for a reason about
 * evidence rather than compatibility: this schema is what `platform/dashboard` `safeParse`s,
 * so against an API deployment that predates these fields a required member makes the WHOLE
 * run unreadable — a reader loses the timeline and the step tree as well, to report a
 * missing decisions list. `undefined` says "this response did not carry them"; `[]` says
 * "there are none". Those are different facts and the contract keeps them apart.
 */
export const RunDetailViewSchema = RunSummaryViewSchema.extend({
  steps: z.array(StepViewSchema),
  decisions: z.array(DecisionViewSchema).optional(),
  modelCalls: z.array(ModelCallViewSchema).optional(),
  toolCalls: z.array(ToolCallViewSchema).optional(),
  errors: z.array(ErrorViewSchema).optional(),
});

export const RunListViewSchema = z.object({
  runs: z.array(RunSummaryViewSchema),
  limit: z.number().int(),
  offset: z.number().int(),
  /** True when at least one more run exists past this page. */
  hasMore: z.boolean(),
});

export const RUNS_LIST_DEFAULT_LIMIT = 50;
export const RUNS_LIST_MAX_LIMIT = 200;

/**
 * `GET /v1/runs` is an unbounded collection and is paginated (ENGINEERING_STANDARDS API-4).
 * The cap is enforced by rejecting an oversized `limit` rather than by silently clamping it:
 * a caller that asks for 5000 and receives 200 without being told has no way to know its
 * page is short.
 */
export const RunsListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(RUNS_LIST_MAX_LIMIT).default(RUNS_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * `GET /v1/runs/:id/summary`'s `droppedTelemetryEventCount` field, and ONLY that field
 * (Reviewer S5, Phase 4 phase gate repair attempt 1).
 *
 * Not a schema for §23's whole `RunSummary` roll-up — `platform/api/src/runs/run-summary.ts`
 * documents at its own head why that type still lives in the API (`p4.run-summary`'s
 * `allowed_paths` excluded `platform/shared/read/**`) and `BACKLOG.md` "§23's `RunSummary`
 * type still lives in the API" tracks the full relocation as a separate, larger, still-open
 * item — including the `RunSummaryView` naming collision a full move would have to resolve.
 * This schema does not attempt that move: it validates the one field
 * `ingestion-health-card.tsx` actually reads, replacing a hand-rolled
 * `typeof value === 'number'` check (`lib/runs-api.ts`'s `fetchRunDroppedTelemetryEventCount`)
 * with the same `safeParse` pattern every other response on this page uses. Extra keys on the
 * real `RunSummary` response (`modelCallCount`, `inputTokens`, ...) are simply ignored by
 * `z.object`'s default (non-strict) parsing — this schema does not have to enumerate them to
 * validate the one it cares about.
 */
export const RunSummaryDropCountSchema = z.object({
  droppedTelemetryEventCount: z.number().int().nullable(),
});

export type StepView = z.infer<typeof StepViewSchema>;
export type DecisionView = z.infer<typeof DecisionViewSchema>;
export type ModelCallView = z.infer<typeof ModelCallViewSchema>;
export type ToolCallView = z.infer<typeof ToolCallViewSchema>;
export type ErrorView = z.infer<typeof ErrorViewSchema>;
export type RunSummaryView = z.infer<typeof RunSummaryViewSchema>;
export type RunDetailView = z.infer<typeof RunDetailViewSchema>;
export type RunListView = z.infer<typeof RunListViewSchema>;
export type RunsListQuery = z.infer<typeof RunsListQuerySchema>;
export type RunSummaryDropCount = z.infer<typeof RunSummaryDropCountSchema>;
