import { z } from 'zod';

import { IdSchema, NameSchema, TimestampSchema } from './primitives';

/**
 * The recommendation and analysis wire contract (MVP_PLAN_V3.md §19, §21, §22).
 *
 * `platform/shared/schema/**` is the only wire contract (`CLAUDE.md` ## Types), and this
 * file is the only source of the recommendation and analysis types — the API and the
 * Dashboard both derive from it with `z.infer`. Nothing here imports
 * `@lengentic/analysis-engine`: the engine's `gate-contract.ts` is an in-process vocabulary
 * for pure functions, this is the shape that crosses a process boundary, and a shared
 * package that reached into the engine would drag an analysis dependency into every SDK
 * consumer. The two are kept in step by `platform/shared/test/contract/recommendation.spec.ts`,
 * whose expected values are transcribed from `MVP_PLAN_V3.md` rather than read off either
 * module.
 *
 * No `severity` field, deliberately: §21 removed it because no deterministic calculation for
 * it was ever specified, and an arbitrary label attached to evidence-based output undermines
 * the evidence. The gate results are shown instead.
 */

// ---------------------------------------------------------------------------
// §19 — gate vocabulary
// ---------------------------------------------------------------------------

/**
 * Report order, G1..G5 (§19). Every evaluation carries one result per entry, in this order.
 * Mirrors `GATE_IDS` in `platform/analysis-engine/src/gate-contract.ts`; both transcribe
 * §19's table, neither reads the other.
 */
export const GATE_IDS = Object.freeze([
  'G1_sample_count',
  'G2_context_diversity',
  'G3_dominance',
  'G4_outcome_success',
  'G5_outcome_coverage',
] as const);

export const GateIdSchema = z.enum(GATE_IDS);

export const GATE_STATUSES = Object.freeze(['PASS', 'FAIL', 'NOT_APPLICABLE'] as const);

export const GateStatusSchema = z.enum(GATE_STATUSES);

export const VERDICTS = Object.freeze(['CANDIDATE', 'SUPPRESSED'] as const);

export const VerdictSchema = z.enum(VERDICTS);

export const GateResultSchema = z.object({
  id: GateIdSchema,
  status: GateStatusSchema,
  /**
   * Human-readable comparison, e.g. `"12 >= 5"`. Evidence for a reader, never an assertion
   * target — formatting is not part of this contract, exactly as
   * `analysis-engine/src/gate-contract.ts` says of its own field. §25's suppressed beat
   * renders this string; nothing parses it.
   */
  comparison: z.string(),
});

/**
 * A complete gate evaluation: exactly one result per `GATE_IDS` member, in `GATE_IDS` order.
 *
 * §19's report order is a rule about what a reader is shown, so a plain
 * `z.array(GateResultSchema)` states it and does not hold it — a gate array with three
 * entries, or with G4 before G3, would parse and then render a report that silently omits or
 * reorders a gate. §19 spends a paragraph forbidding exactly the understated report, and
 * `platform/shared/schema/**` is the only place the plan lets the invariant live.
 *
 * Both the persisted evidence and the analysis response use this schema, so the two cannot
 * drift apart: §21's output shape prints five gate lines for a CANDIDATE, and §25 beat 6
 * renders the failing gate of a SUPPRESSED group from the same array.
 */
export const GateResultsSchema = z
  .array(GateResultSchema)
  .length(GATE_IDS.length)
  .superRefine((gates, ctx) => {
    GATE_IDS.forEach((id, index) => {
      if (gates[index]?.id !== id) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `§19 report order: gate ${String(index)} must be ${id}`,
        });
      }
    });
  });

// ---------------------------------------------------------------------------
// §21 — the recommendation entity
// ---------------------------------------------------------------------------

/**
 * §21's required output shape names exactly one category. The second analyzer (§20.2,
 * repeated failed action) has no persistence owner in 5b and no Definition-of-Done line
 * asking for one, so a second member here would be a wire value nothing can produce —
 * `docs/ENGINEERING_STANDARDS.md` DESIGN-1 wants a second REAL variation, not an imagined
 * one. Adding a member later is additive for producers.
 */
export const RECOMMENDATION_CATEGORIES = Object.freeze(['DETERMINISTIC_CANDIDATE'] as const);

export const RecommendationCategorySchema = z.enum(RECOMMENDATION_CATEGORIES);

/** §21: two values only. There is no ACKNOWLEDGED, no SNOOZED, and no severity. */
export const RECOMMENDATION_STATUSES = Object.freeze(['OPEN', 'DISMISSED'] as const);

export const RecommendationStatusSchema = z.enum(RECOMMENDATION_STATUSES);

/**
 * The attested outcome carried on a counterexample. Re-declared rather than imported from
 * `DecisionOutcomeSchema` (`./decision-events.ts`) so that the ingest vocabulary and the
 * analysis vocabulary can move independently — the same reason `read/run-view.ts` keeps
 * `RunViewStatus` apart from `RunStatus`.
 *
 * It is a strict SUBSET of the ingest outcome, and deliberately: §20.1 defines a
 * counterexample as a dominant-option FAILURE or a minority-option SUCCESS, so `UNKNOWN` is
 * neither and cannot name one. `extractCounterexamples`
 * (`platform/analysis-engine/src/aggregate.ts:170`) filters on exactly those two outcomes and
 * can emit nothing else, so this narrows the wire to what a producer can actually produce.
 */
export const RecommendationOutcomeSchema = z.enum(['SUCCESS', 'FAILURE'] as const);

/**
 * §18's corrected group key. `contextKey` is deliberately not a member — it is a dimension
 * measured *within* a group, and including it would pin `distinctContextKeyCount` to 1 and
 * make G2 unsatisfiable.
 */
export const RecommendationGroupKeySchema = z.object({
  workflowName: NameSchema,
  workflowVersion: NameSchema,
  decisionType: NameSchema,
  contextKeyVersion: NameSchema,
});

/**
 * §21's `configSnapshot` — "the thresholds in force when this was produced". A
 * recommendation produced under a 30-sample threshold means something different from one
 * produced under 50, and without the snapshot the difference is invisible.
 *
 * Every field required: a partial snapshot would let a reader believe a threshold was
 * recorded when it was merely omitted. Mirrors `AnalyzerConfig`
 * (`platform/analysis-engine/src/config.ts`) field for field.
 */
export const AnalyzerConfigSnapshotSchema = z.object({
  /** G1 — minimum observations before any claim is made. */
  minSampleCount: z.number().int().nonnegative(),
  /** G2 — minimum distinct contextKeys the observations must span. */
  minDistinctContexts: z.number().int().nonnegative(),
  /** G3 — minimum share held by the dominant option, 0..1. */
  dominanceThreshold: z.number().min(0).max(1),
  /** G4 — minimum attested success rate for the dominant option, 0..1. */
  successThreshold: z.number().min(0).max(1),
  /** G5 — minimum fraction of decisions carrying a non-UNKNOWN outcome, 0..1. */
  coverageThreshold: z.number().min(0).max(1),
});

export const OptionCountSchema = z.object({
  option: NameSchema,
  count: z.number().int().nonnegative(),
  /** Fraction of `sampleCount`, 0..1. */
  share: z.number().min(0).max(1),
});

/**
 * Where the minority sits (§18). A minority concentrated in one context names the
 * escape-hatch condition; a scattered minority says the boundary is not context-shaped.
 * §25's "Concentration: 1 of 1 minority row in post_refactor_large_diff" line is rendered
 * from this array, and the 5b Definition of Done requires it to be rendered.
 */
export const ContextConcentrationSchema = z.object({
  contextKey: NameSchema,
  count: z.number().int().nonnegative(),
  /** Fraction of the minority, 0..1. */
  share: z.number().min(0).max(1),
});

/**
 * A dominant-option FAILURE or a minority-option SUCCESS (§20.1) — the evidence *against*
 * the recommendation, never summarized away.
 */
export const CounterexampleSchema = z.object({
  decisionId: IdSchema,
  runId: IdSchema,
  contextKey: NameSchema,
  selectedOption: NameSchema,
  outcome: RecommendationOutcomeSchema,
});

export const ExclusionCountsSchema = z.object({
  staleRun: z.number().int().nonnegative(),
  missingContextKey: z.number().int().nonnegative(),
});

/**
 * §21's `evidence` — everything §21's required output shape renders except the group key,
 * the counterexamples and the note, each of which is a field of its own.
 *
 * `gates` lives here rather than beside `evidence` because a persisted recommendation has
 * to be able to render its own Gates block long after the analysis run that produced it;
 * §21's output shape prints five gate lines for a CANDIDATE, and evidence that omitted them
 * could not.
 */
export const RecommendationEvidenceSchema = z.object({
  sampleCount: z.number().int().nonnegative(),
  distinctContextKeyCount: z.number().int().nonnegative(),
  optionDistribution: z.array(OptionCountSchema),
  /** Null for a group with no observations; §25 never renders a recommendation for one. */
  dominantOption: NameSchema.nullable(),
  /** 0..1. Rendered as a percentage; stored as the fraction the gates compare. */
  dominancePercentage: z.number().min(0).max(1),
  attestedCount: z.number().int().nonnegative(),
  /** 0..1. Fraction of samples carrying a non-UNKNOWN outcome. */
  outcomeCoverage: z.number().min(0).max(1),
  /**
   * 0..1, or `null` when nothing has been attested for the dominant option.
   *
   * Null is not zero, and this is the wire half of a Definition-of-Done line: the Dashboard
   * renders `N/A`, never `0.0%`, when no outcomes are attested. A non-nullable number here
   * would force a producer to manufacture the `0.0%` the plan forbids, one layer before any
   * renderer could refuse it. §19's G4 evaluates this field specifically — a blended rate
   * across all options can clear the gate while the option being recommended is the one
   * that fails.
   */
  dominantOptionAttestedSuccessRate: z.number().min(0).max(1).nullable(),
  minorityContextConcentration: z.array(ContextConcentrationSchema),
  excluded: ExclusionCountsSchema,
  /** One entry per `GATE_IDS` member, in `GATE_IDS` order — enforced by `GateResultsSchema`. */
  gates: GateResultsSchema,
});

/**
 * §21's `sourceWatermark` is "what data range it was computed over", and §21 gives it no
 * shape. Analysis in the MVP is a full recomputation from the beginning of history (§22:
 * explicit, on demand, no incremental job and no job table), so the range has exactly one
 * moving end: its upper bound. This is that bound — the newest source instant the analysis
 * run included — and the lower bound is "everything". Encoding two ends would put a second
 * number on the wire that no producer can vary, which reads as a capability the MVP does
 * not have.
 */
export const SourceWatermarkSchema = TimestampSchema;

/** SHA-256, lowercase hex. See `platform/api/src/recommendations/fingerprint.ts`. */
export const FingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Bound on the optional `note` a status change may carry. */
export const MAX_STATUS_NOTE_LENGTH = 2000;

/**
 * One persisted recommendation, on the wire. §21's persisted-field list, plus the id, the
 * category and the group key.
 *
 * The group key is stored and returned rather than folded into `evidence`: it is the
 * fingerprint's own input set, so keeping it addressable is what makes a fingerprint
 * auditable after the fact, and §21's output shape renders `Workflow: demo-workflow @
 * a1b2c3d` from it.
 */
export const RecommendationSchema = z.object({
  id: IdSchema,
  category: RecommendationCategorySchema,
  analyzerId: NameSchema,
  analyzerVersion: NameSchema,
  groupKey: RecommendationGroupKeySchema,
  configSnapshot: AnalyzerConfigSnapshotSchema,
  sourceWatermark: SourceWatermarkSchema,
  fingerprint: FingerprintSchema,
  evidence: RecommendationEvidenceSchema,
  /**
   * Always present. It may be empty; it is never omitted (§20.1, `CLAUDE.md` ## Product
   * claims). `.optional()` here would make "we found no counterevidence" and "this producer
   * does not report counterevidence" the same value to every consumer.
   */
  counterexamples: z.array(CounterexampleSchema),
  firstSeenAt: TimestampSchema,
  lastSeenAt: TimestampSchema,
  status: RecommendationStatusSchema,
  /** The `note` from the last status change, or null if none was given. */
  statusNote: z.string().max(MAX_STATUS_NOTE_LENGTH).nullable(),
  /** When the status was last changed explicitly; null while it has never been changed. */
  statusChangedAt: TimestampSchema.nullable(),
});

// ---------------------------------------------------------------------------
// The list read — `GET /v1/recommendations`
// ---------------------------------------------------------------------------

/**
 * `GET /v1/recommendations` is an unbounded collection and is therefore paginated
 * (`docs/ENGINEERING_STANDARDS.md` API-4). The cap is enforced by REJECTING an oversized
 * `limit` rather than silently clamping it, exactly as `RunsListQuerySchema` does: a caller
 * that asks for 5000 and receives 200 without being told has no way to know its page is
 * short — and a short page of recommendations is a page of evidence that quietly went
 * missing.
 *
 * The two bounds are `GET /v1/runs`' bounds. A second pair of numbers for the same question
 * would be a difference a reader has to explain.
 */
export const RECOMMENDATIONS_LIST_DEFAULT_LIMIT = 50;
export const RECOMMENDATIONS_LIST_MAX_LIMIT = 200;

export const RecommendationsListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(RECOMMENDATIONS_LIST_MAX_LIMIT)
    .default(RECOMMENDATIONS_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * The list read's envelope, frozen.
 *
 * §21 specifies the entity and its PATCH; §22 specifies the analysis run. Neither names the
 * list read, yet §25 beats 4 and 5 can only be rendered from one: `evidence`,
 * `minorityContextConcentration`, the attested rate and **every counterexample** live on the
 * persisted recommendation and nowhere else — §22's analysis response carries gates and a
 * verdict and no evidence at all. The endpoint was decided (`RECOMMENDATIONS_PATH` has been
 * in this file since `p5.rec-persistence`) and never built, and the Dashboard read it in two
 * shapes at once because there was nothing here to read.
 *
 * An object rather than a bare array, and the same four fields `RunListViewSchema` uses:
 * pagination has nowhere to live on a bare array, and "did the page end here" is not a
 * question a consumer can answer from the array's own length.
 */
export const RecommendationListViewSchema = z.object({
  recommendations: z.array(RecommendationSchema),
  limit: z.number().int(),
  offset: z.number().int(),
  /** True when at least one more recommendation exists past this page. */
  hasMore: z.boolean(),
});

// ---------------------------------------------------------------------------
// §22 — the analysis trigger and its response
// ---------------------------------------------------------------------------

export const ANALYSIS_RUN_PATH = '/v1/analysis/run';
export const RECOMMENDATIONS_PATH = '/v1/recommendations';

/**
 * §22 defines `POST /v1/analysis/run` with no parameters: analysis is explicit and on
 * demand, over everything, and the thresholds in force come from the server's own
 * configuration and are recorded on each row as `configSnapshot`. The schema exists so the
 * endpoint has something to validate against and so "the body carries no parameters" is a
 * checkable statement rather than an omission.
 *
 * `.default({})` is what makes "no parameters" true of the REQUEST and not only of the body:
 * an endpoint documented as taking none must accept `curl -X POST /v1/analysis/run` with no
 * `content-type` and no body at all, which is the plainest invocation there is and the one a
 * demo or a shell script reaches for. Without the default that call arrives as `undefined`
 * and `z.object({})` rejects it — a 400 on the documented invocation (Tester, 5b phase gate,
 * FINDING 4). The default applies to `undefined` alone, so an array, a string or any other
 * non-object body is still a 400.
 */
export const AnalysisRunRequestSchema = z.object({}).default({});

/**
 * One group the engine looked at — emitted or not.
 *
 * A `SUPPRESSED` group carries `recommendationId: null`, is returned here, and is **never**
 * persisted as an entity: there is no suppression table and no suppression history in the
 * MVP (§22). The refusal is the claim the product makes, so it has to be on the wire — §25's
 * closing beat renders a low-diversity group at `SUPPRESSED / G2 context_diversity (2 < 5)`,
 * and a response that returned only what it emitted would have nothing to render.
 *
 * `groupKey` is carried alongside §22's four literal fields because a row with no identity
 * cannot be rendered: §25 beat 6 names the workflow and decision it is refusing to make a
 * claim about. It is additive — a consumer written against the four-field shape still parses.
 */
export const EvaluatedGroupSchema = z
  .object({
    groupKey: RecommendationGroupKeySchema,
    verdict: VerdictSchema,
    /**
     * Exactly the ids whose status is FAIL — **all** of them, not the first (§19's reporting
     * rule). A NOT_APPLICABLE gate never appears here. Empty iff `verdict` is CANDIDATE.
     */
    failedGates: z.array(GateIdSchema),
    /** One entry per `GATE_IDS` member, in `GATE_IDS` order, whatever the verdict. */
    gates: GateResultsSchema,
    /**
     * 0..1, or `null` when nothing has been attested for the dominant option — the same
     * field, with the same meaning, as `RecommendationEvidence`'s.
     *
     * The one evidence number that is carried on an otherwise evidence-free row, and it is
     * here because the Definition-of-Done line above it ("renders `N/A`, never `0.0%`, when
     * no outcomes are attested") is otherwise **unreachable through the running product**.
     * The null case implies G4 is NOT_APPLICABLE, which implies every attested row belongs
     * to a minority option, which caps `outcomeCoverage` at `1 - dominancePercentage` — at
     * most 10% wherever G3 passes at its 90% default — so G5 always fails and the group is
     * always SUPPRESSED. A SUPPRESSED group persists no row, and a persisted row is a
     * CANDIDATE by construction, so no persisted recommendation can ever carry the null the
     * renderer exists to refuse. Tester measured exactly that at the 5b phase gate: `N/A`
     * rendered 0 times against the real API, and `dominantOptionAttestedSuccessRate`
     * appeared 0 times in the live analysis response (FINDING 3).
     *
     * Carried on **every** evaluated group, SUPPRESSED ones included, for that reason: the
     * SUPPRESSED group is the only place the null is producible, so excluding it would leave
     * the field decorative. Additive — a consumer written against the previous shape still
     * parses.
     */
    dominantOptionAttestedSuccessRate: z.number().min(0).max(1).nullable(),
    /** The persisted row's id for a CANDIDATE; null for a SUPPRESSED group. */
    recommendationId: IdSchema.nullable(),
  })
  .superRefine((group, ctx) => {
    // §19's reporting rule, encoded rather than described. Derived from `gates` on every
    // parse, so `failedGates` cannot understate the problem: "suppressed by G2" when it also
    // fails G4 is the exact failure §19 spends a paragraph forbidding, and a producer that
    // reported only the first failing gate would otherwise be indistinguishable on the wire
    // from one that reported all of them.
    const failed = group.gates.filter((gate) => gate.status === 'FAIL').map((gate) => gate.id);

    if (
      group.failedGates.length !== failed.length ||
      group.failedGates.some((id, index) => id !== failed[index])
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['failedGates'],
        message:
          '§19 reporting rule: `failedGates` must be every FAIL id in `gates`, all of them, in report order',
      });
    }

    // "Verdict is SUPPRESSED if any gate fails", and `failedGates` is empty iff CANDIDATE —
    // one biconditional, so a group cannot be emitted as a CANDIDATE while carrying a failure.
    const impliedVerdict = failed.length === 0 ? 'CANDIDATE' : 'SUPPRESSED';

    if (group.verdict !== impliedVerdict) {
      ctx.addIssue({
        code: 'custom',
        path: ['verdict'],
        message: `§19: verdict is SUPPRESSED iff a gate failed — these gates imply ${impliedVerdict}`,
      });
    }

    // §22: a SUPPRESSED group is never persisted as an entity, so it has no row to name; a
    // CANDIDATE always has one. A null id on a CANDIDATE is a recommendation nothing can link
    // to, and a non-null id on a SUPPRESSED group asserts a suppression table the MVP does
    // not have.
    if ((group.recommendationId === null) === (group.verdict === 'CANDIDATE')) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommendationId'],
        message:
          '§22: `recommendationId` names the persisted row for a CANDIDATE and is null for a SUPPRESSED group',
      });
    }
  });

export const AnalysisRunResponseSchema = z.object({
  /**
   * Every evaluated group, not only the emitted ones. Ordering is the engine's grouping
   * order and is not part of this contract.
   */
  evaluatedGroups: z.array(EvaluatedGroupSchema),
});

/**
 * `PATCH /v1/recommendations/:id/status` — §21's `{ status, note? }`.
 *
 * Both directions are accepted. §21's "DISMISSED stays DISMISSED" is a rule about
 * RE-ANALYSIS — it sits in §21's re-analysis rule block, and the 5b Definition of Done
 * spells out "stays dismissed **across re-analysis**". A human explicitly re-opening a
 * recommendation is not re-analysis, and refusing it here would leave a mis-clicked
 * DISMISSED unrecoverable without a database edit.
 */
export const RecommendationStatusPatchSchema = z.object({
  status: RecommendationStatusSchema,
  note: z.string().min(1).max(MAX_STATUS_NOTE_LENGTH).optional(),
});

export type GateId = z.infer<typeof GateIdSchema>;
export type GateStatus = z.infer<typeof GateStatusSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
export type GateResult = z.infer<typeof GateResultSchema>;
export type GateResults = z.infer<typeof GateResultsSchema>;
export type RecommendationCategory = z.infer<typeof RecommendationCategorySchema>;
export type RecommendationStatus = z.infer<typeof RecommendationStatusSchema>;
export type RecommendationOutcome = z.infer<typeof RecommendationOutcomeSchema>;
export type RecommendationGroupKey = z.infer<typeof RecommendationGroupKeySchema>;
export type AnalyzerConfigSnapshot = z.infer<typeof AnalyzerConfigSnapshotSchema>;
export type OptionCount = z.infer<typeof OptionCountSchema>;
export type ContextConcentration = z.infer<typeof ContextConcentrationSchema>;
export type Counterexample = z.infer<typeof CounterexampleSchema>;
export type ExclusionCounts = z.infer<typeof ExclusionCountsSchema>;
export type RecommendationEvidence = z.infer<typeof RecommendationEvidenceSchema>;
export type Recommendation = z.infer<typeof RecommendationSchema>;
export type RecommendationsListQuery = z.infer<typeof RecommendationsListQuerySchema>;
export type RecommendationListView = z.infer<typeof RecommendationListViewSchema>;
export type EvaluatedGroup = z.infer<typeof EvaluatedGroupSchema>;
export type AnalysisRunRequest = z.infer<typeof AnalysisRunRequestSchema>;
export type AnalysisRunResponse = z.infer<typeof AnalysisRunResponseSchema>;
export type RecommendationStatusPatch = z.infer<typeof RecommendationStatusPatchSchema>;
