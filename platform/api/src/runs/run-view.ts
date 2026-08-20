import { z } from 'zod';
import { MetadataSchema, RunStatusSchema, TimestampSchema } from '@lengentic/shared';

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
 * **Placement is a known open item.** The settled destination for this vocabulary is
 * `platform/shared/read/**` (BACKLOG.md, "`STALE` needs a read-model vocabulary" — Architect
 * option B), so that `p2.dashboard-runs` can import the response contract instead of
 * hand-declaring a twin. `platform/shared/**` is outside this lane's `allowed_paths`
 * (`platform/api/src/**`), so the module lives here and is written to be moved wholesale:
 * it imports only from `@lengentic/shared` and `zod`, and nothing in it knows about Prisma,
 * Nest or this package. See the lane handoff's `follow_up_required`.
 */

/**
 * The stored statuses plus `STALE`.
 *
 * Written out rather than spread from `RUN_STATUSES`, so that widening the stored enum is a
 * loud compile-and-test event here instead of a silent widening of the response. Both
 * directions of the relationship — every stored status is representable, and `STALE` never
 * leaks back into the stored enum — are asserted in `run-view.spec.ts`.
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
 * Steps arrive as a flat, deterministically ordered array carrying `parentStepId`.
 *
 * Not a server-built tree: a child whose parent has not arrived (§13 — no foreign key, and
 * "posting a child Step before its parent produces the correct tree" is a Phase 2 DoD line)
 * is an ordinary member of this array, and whether it renders nested or orphaned is one map
 * lookup at the consumer. Building the tree here would force the API to invent a placement
 * for a parent it has never seen.
 */
export const RunDetailViewSchema = RunSummaryViewSchema.extend({
  steps: z.array(StepViewSchema),
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

export type StepView = z.infer<typeof StepViewSchema>;
export type RunSummaryView = z.infer<typeof RunSummaryViewSchema>;
export type RunDetailView = z.infer<typeof RunDetailViewSchema>;
export type RunListView = z.infer<typeof RunListViewSchema>;
export type RunsListQuery = z.infer<typeof RunsListQuerySchema>;
