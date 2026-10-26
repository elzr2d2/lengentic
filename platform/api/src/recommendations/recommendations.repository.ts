import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  AnalyzerConfigSnapshotSchema,
  CounterexampleSchema,
  RecommendationEvidenceSchema,
  RepeatedFailedActionConfigSnapshotSchema,
  RepeatedFailedActionCounterexampleSchema,
  RepeatedFailedActionEvidenceSchema,
  type AnalyzerConfigSnapshot,
  type Counterexample,
  type RecommendationCategory,
  type RecommendationEvidence,
  type RecommendationStatus,
  type RepeatedFailedActionConfigSnapshot,
  type RepeatedFailedActionCounterexample,
  type RepeatedFailedActionEvidence,
} from '@lengentic/shared';
import { z } from 'zod';
import type { PrismaClient } from '@lengentic/database';

import { PrismaService } from '../prisma/prisma.service';
import { recommendationFingerprint } from './fingerprint';
import type {
  RecommendationRecord,
  RecommendationSighting,
  RepeatedFailedActionRecord,
  RepeatedFailedActionSighting,
  WithdrawalResult,
} from './recommendation-record';

// Row and JSON-input shapes recovered structurally from `PrismaClient` itself — the same
// technique `runs.repository.ts` and `decisions.repository.ts` use, and for the same reason:
// `@lengentic/database` exports only the client type (`CLAUDE.md` ## Types), so a column
// rename breaks this file at compile time instead of silently producing a `null` field.
type RecommendationRow = NonNullable<
  Awaited<ReturnType<PrismaClient['recommendation']['findUnique']>>
>;

type RecommendationJsonInput = NonNullable<
  Parameters<PrismaClient['recommendation']['upsert']>[0]['create']
>['evidence'];

/**
 * The three JSON columns are NOT NULL and are written only from values that already
 * satisfied their wire schema, so the failure branch is unreachable through the supported
 * path. It throws rather than degrading to a default — unlike `runs.repository.ts`'s
 * `toMetadata`, which returns `null` so one hand-edited row cannot take down a whole list.
 *
 * The asymmetry is deliberate. A run whose `metadata` is unreadable is still a run worth
 * rendering; a recommendation whose `evidence` is unreadable is a claim with no evidence
 * behind it, and `CLAUDE.md` ## Product claims does not have a degraded mode for that. There
 * is no substitute value here that is not a fabrication.
 */
function parseColumn<T>(schema: z.ZodType<T>, value: unknown, column: string, id: string): T {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    // No note about the row's own contents in the message — ERR-4. The id is an internal
    // identifier and this string never reaches a response body: the throw is a 500.
    throw new Error(`Recommendation ${id} has an unreadable ${column} column`);
  }

  return parsed.data;
}

const CounterexampleListSchema = z.array(CounterexampleSchema);
const RepeatedFailedActionCounterexampleListSchema = z.array(
  RepeatedFailedActionCounterexampleSchema,
);

/**
 * The identity columns a category must carry. The table holds both analyzers' rows
 * (`schema.prisma`: the four group-key columns and the three action-key columns are each NULL
 * for the other category), so a row whose columns do not match its category is corrupt, and
 * this throws on it for the reason `parseColumn` does — a recommendation with the wrong
 * identity is a claim about nothing.
 */
function requireIdentity(
  values: readonly (string | null)[],
  category: RecommendationCategory,
  id: string,
): void {
  if (values.some((value) => value === null)) {
    throw new Error(`Recommendation ${id} (${category}) is missing an identity column`);
  }
}

export function toRecommendationRecord(row: RecommendationRow): RecommendationRecord {
  if (row.category !== 'DETERMINISTIC_CANDIDATE') {
    throw new Error(`Recommendation ${row.id} is ${row.category}, not DETERMINISTIC_CANDIDATE`);
  }

  requireIdentity(
    [row.workflowName, row.workflowVersion, row.decisionType, row.contextKeyVersion],
    row.category,
    row.id,
  );

  return {
    id: row.id,
    category: row.category,
    analyzerId: row.analyzerId,
    analyzerVersion: row.analyzerVersion,
    groupKey: {
      workflowName: row.workflowName ?? '',
      workflowVersion: row.workflowVersion ?? '',
      decisionType: row.decisionType ?? '',
      contextKeyVersion: row.contextKeyVersion ?? '',
    },
    configSnapshot: parseColumn(
      AnalyzerConfigSnapshotSchema,
      row.configSnapshot,
      'configSnapshot',
      row.id,
    ),
    sourceWatermark: row.sourceWatermark,
    fingerprint: row.fingerprint,
    evidence: parseColumn(RecommendationEvidenceSchema, row.evidence, 'evidence', row.id),
    counterexamples: parseColumn(
      CounterexampleListSchema,
      row.counterexamples,
      'counterexamples',
      row.id,
    ),
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    status: row.status,
    statusNote: row.statusNote,
    statusChangedAt: row.statusChangedAt,
  };
}

export function toRepeatedFailedActionRecord(row: RecommendationRow): RepeatedFailedActionRecord {
  if (row.category !== 'REPEATED_FAILED_ACTION') {
    throw new Error(`Recommendation ${row.id} is ${row.category}, not REPEATED_FAILED_ACTION`);
  }

  requireIdentity([row.runId, row.toolName, row.inputFingerprint], row.category, row.id);

  return {
    id: row.id,
    category: row.category,
    analyzerId: row.analyzerId,
    analyzerVersion: row.analyzerVersion,
    actionKey: {
      runId: row.runId ?? '',
      toolName: row.toolName ?? '',
      inputFingerprint: row.inputFingerprint ?? '',
    },
    configSnapshot: parseColumn(
      RepeatedFailedActionConfigSnapshotSchema,
      row.configSnapshot,
      'configSnapshot',
      row.id,
    ),
    sourceWatermark: row.sourceWatermark,
    fingerprint: row.fingerprint,
    evidence: parseColumn(RepeatedFailedActionEvidenceSchema, row.evidence, 'evidence', row.id),
    counterexamples: parseColumn(
      RepeatedFailedActionCounterexampleListSchema,
      row.counterexamples,
      'counterexamples',
      row.id,
    ),
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    status: row.status,
    statusNote: row.statusNote,
    statusChangedAt: row.statusChangedAt,
  };
}

/** Either category's record, chosen by the row's own `category`. */
export function toAnyRecommendationRecord(
  row: RecommendationRow,
): RecommendationRecord | RepeatedFailedActionRecord {
  return row.category === 'REPEATED_FAILED_ACTION'
    ? toRepeatedFailedActionRecord(row)
    : toRecommendationRecord(row);
}

/**
 * The three JSON columns, on their way in.
 *
 * No `as`. The previous version took `unknown` and asserted, which
 * `docs/ENGINEERING_STANDARDS.md` ## TS allows only with the proof written beside it — and
 * the proof was never written, because the assertion was never needed. Naming the three wire
 * values this repository actually writes is enough: each is a `z.infer` of a schema built
 * from `z.object`, `z.array`, `z.string`, `z.number` and `z.enum` alone
 * (`platform/shared/schema/recommendation.ts`), so each is a plain object, array, string or
 * number — no `Date`, no class instance, no cycle — and assignable to Prisma's JSON input on
 * its own structure. The compiler checks the claim instead of being told it.
 *
 * Keeping the function rather than passing the values straight through is what pins that:
 * widen this parameter back to `unknown`, or add a fourth column carrying a `Date`, and the
 * failure is a type error here rather than a row that round-trips into an unreadable column.
 */
function toJsonInput(
  value:
    | AnalyzerConfigSnapshot
    | RecommendationEvidence
    | readonly Counterexample[]
    | RepeatedFailedActionConfigSnapshot
    | RepeatedFailedActionEvidence
    | readonly RepeatedFailedActionCounterexample[],
): RecommendationJsonInput {
  return value;
}

/**
 * The five columns an analysis run re-states about a group it has just looked at, and the
 * only five — `status`, `firstSeenAt`, `statusNote`, `statusChangedAt` and the six identity
 * columns are absent, and each absence is a §21 rule (see `recordSighting`).
 *
 * One definition rather than two because both writes that re-state a sighting use it:
 * `recordSighting`'s `update` branch, and the DISMISSED tombstone `withdrawOnSuppression`
 * refreshes. A sixth column added to one and not the other would be a row whose evidence
 * agrees with its gates on one path and not the other.
 */
function resightedColumns(sighting: RecommendationSighting | RepeatedFailedActionSighting) {
  return {
    configSnapshot: toJsonInput(sighting.configSnapshot),
    sourceWatermark: sighting.sourceWatermark,
    evidence: toJsonInput(sighting.evidence),
    counterexamples: toJsonInput(sighting.counterexamples),
    lastSeenAt: sighting.observedAt,
  };
}

/**
 * Newest discovery first, tie-broken on `id`.
 *
 * `firstSeenAt` and not `lastSeenAt`, deliberately. An analysis run stamps every row it
 * touches with ONE `observedAt` reading (`analysis.service.ts` — "one clock reading for the
 * whole run"), so ordering on `lastSeenAt` would give every row on the page an identical key
 * and re-shuffle the entire list on each re-analysis, while `firstSeenAt` is written once and
 * never updated (`recordSighting`'s `update` branch omits it). The reader sees the same order
 * twice unless something new was actually found.
 *
 * That same single reading is why the `id` tie-break is required rather than decorative: two
 * recommendations first seen by one run collide exactly, and leaving the tie to Postgres would
 * let page 2 repeat or skip a row page 1 already showed — the defect `RUN_LIST_ORDER` names.
 */
const RECOMMENDATION_LIST_ORDER = [{ firstSeenAt: 'desc' }, { id: 'desc' }] as const;

/**
 * The `Recommendation` table — §21's entity and its lifecycle.
 *
 * No Prisma type crosses this file outward (`CLAUDE.md` ## Types): every public method takes
 * and returns a domain shape, and `toRecommendationRecord` above is the persistence edge.
 */
@Injectable()
export class RecommendationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One page of recommendations, every status included.
   *
   * DISMISSED rows are returned rather than filtered out: §21 keeps a dismissal so a
   * re-analysis cannot resurrect it, and a list that hid them would make a dismissed
   * recommendation indistinguishable from one that was never found — the reader would have no
   * way to see the counterevidence they dismissed it over.
   */
  async listRecommendations(take: number, skip: number): Promise<RecommendationRecord[]> {
    const rows = await this.prisma.client.recommendation.findMany({
      where: { category: 'DETERMINISTIC_CANDIDATE' },
      orderBy: [...RECOMMENDATION_LIST_ORDER],
      take,
      skip,
    });

    return rows.map(toRecommendationRecord);
  }

  /** `listRecommendations`, for §20.2 rows. Same order, same DISMISSED-included rule. */
  async listRepeatedFailedActions(
    take: number,
    skip: number,
  ): Promise<RepeatedFailedActionRecord[]> {
    const rows = await this.prisma.client.recommendation.findMany({
      where: { category: 'REPEATED_FAILED_ACTION' },
      orderBy: [...RECOMMENDATION_LIST_ORDER],
      take,
      skip,
    });

    return rows.map(toRepeatedFailedActionRecord);
  }

  /**
   * §21's re-analysis rule for §20.2: the same single `upsert` on the UNIQUE fingerprint, the
   * same five re-stated columns (`resightedColumns`), and therefore the same lifecycle — a
   * DISMISSED streak stays DISMISSED, `firstSeenAt` is written once. Only the identity columns
   * differ: the three action-key columns on create, the four group-key columns left NULL.
   */
  async recordRepeatedFailedActionSighting(
    sighting: RepeatedFailedActionSighting,
  ): Promise<RepeatedFailedActionRecord> {
    const fingerprint = recommendationFingerprint({
      analyzerId: sighting.analyzerId,
      analyzerVersion: sighting.analyzerVersion,
      actionKey: sighting.actionKey,
    });

    const resighted = resightedColumns(sighting);

    const row = await this.prisma.client.recommendation.upsert({
      where: { fingerprint },
      create: {
        id: randomUUID(),
        category: sighting.category,
        analyzerId: sighting.analyzerId,
        analyzerVersion: sighting.analyzerVersion,
        runId: sighting.actionKey.runId,
        toolName: sighting.actionKey.toolName,
        inputFingerprint: sighting.actionKey.inputFingerprint,
        fingerprint,
        firstSeenAt: sighting.observedAt,
        ...resighted,
      },
      update: resighted,
    });

    return toRepeatedFailedActionRecord(row);
  }

  /**
   * §20.2's withdrawal: a persisted streak this run no longer emits is removed, with the same
   * DISMISSED exception `withdrawOnSuppression` has (`docs/decisions/0015`) — a DISMISSED row
   * asserts no recommendation and carries a human act, so it stays.
   *
   * One `deleteMany` naming the fingerprints the run DID emit, rather than one call per
   * absent key: §20.2 has no per-key SUPPRESSED verdict to iterate (a key that does not
   * qualify is simply not emitted), so "everything of this category not in the emitted set"
   * is the only statement of the rule there is. A DISMISSED tombstone's evidence is not
   * refreshed here, unlike `withdrawOnSuppression`: there is no suppressing evidence to
   * refresh it with — the run saw no streak at all.
   */
  async withdrawRepeatedFailedActionsExcept(emitted: readonly string[]): Promise<number> {
    const deleted = await this.prisma.client.recommendation.deleteMany({
      where: {
        category: 'REPEATED_FAILED_ACTION',
        status: { not: 'DISMISSED' },
        fingerprint: { notIn: [...emitted] },
      },
    });

    return deleted.count;
  }

  /**
   * §21's re-analysis rule, in one statement: "re-analysis with the same fingerprint UPDATES
   * evidence and `lastSeenAt`. It does not insert a duplicate."
   *
   * `upsert` keyed on the UNIQUE `fingerprint` column rather than a find-then-write. The
   * uniqueness constraint is what makes the rule a property of the database: two analysis
   * runs racing each other both see no row under a find-then-write and both insert, and the
   * duplicate §21 forbids is created by the very code path that exists to prevent it.
   *
   * The `update` branch names FIVE columns and no others, and the omissions are the whole
   * lifecycle:
   *
   * - `status` is absent, so a DISMISSED recommendation stays DISMISSED across re-analysis
   *   (§21, and a 5b Definition-of-Done line). The `@default(OPEN)` on the column applies to
   *   the create branch only.
   * - `firstSeenAt` is absent: it is when this recommendation was FIRST seen, and a re-sighting
   *   is by definition not that.
   * - `statusNote` / `statusChangedAt` are absent: they record a human's explicit act, and an
   *   analysis run has no opinion about one.
   * - The six identity columns (`analyzerId`, `analyzerVersion`, and the four group-key
   *   columns) are absent because they are the fingerprint's own inputs — matching this
   *   `where` means they are already equal, so writing them would be a no-op that invites a
   *   reader to believe they can change.
   *
   * The `create` branch's `id` is generated here rather than by a column default, so the
   * value the row is created with stays visible to the code that created it. It is used only
   * when no row matches; on the update path Postgres never reads it.
   */
  async recordSighting(sighting: RecommendationSighting): Promise<RecommendationRecord> {
    const fingerprint = recommendationFingerprint({
      analyzerId: sighting.analyzerId,
      analyzerVersion: sighting.analyzerVersion,
      groupKey: sighting.groupKey,
    });

    const resighted = resightedColumns(sighting);

    const row = await this.prisma.client.recommendation.upsert({
      where: { fingerprint },
      create: {
        id: randomUUID(),
        category: sighting.category,
        analyzerId: sighting.analyzerId,
        analyzerVersion: sighting.analyzerVersion,
        workflowName: sighting.groupKey.workflowName,
        workflowVersion: sighting.groupKey.workflowVersion,
        decisionType: sighting.groupKey.decisionType,
        contextKeyVersion: sighting.groupKey.contextKeyVersion,
        fingerprint,
        firstSeenAt: sighting.observedAt,
        ...resighted,
      },
      update: resighted,
    });

    return toRecommendationRecord(row);
  }

  /**
   * The other half of §22's "a SUPPRESSED group is not an entity": a group that USED to be a
   * CANDIDATE and no longer is must not keep the row its last candidacy wrote.
   *
   * `recordSighting` says "do not write one"; it never said "remove the one that is there",
   * and the two are not the same statement. Tester measured the gap at the 5b phase gate
   * (FINDING 1): a group answered `SUPPRESSED | failedGates ["G3_dominance"]` on the wire
   * while the table held `OPEN | 50 samples | 0.96 dominance | G3 PASS` for the same group at
   * the same instant, and `GET /v1/recommendations` served it. The page then printed the
   * refusal and the superseded claim one above the other.
   *
   * **DISMISSED is the one exception, and it is kept as a tombstone** (human decision,
   * `docs/decisions/0015`). §21's "DISMISSED stays DISMISSED" would otherwise be lost across
   * a suppression excursion — dismissed, suppressed, candidate again would resurrect as a
   * fresh `OPEN` row, and the human's dismissal would have been deleted by an analysis run
   * that has no opinion about it. A DISMISSED row asserts no recommendation, so keeping it
   * does not make suppression an entity.
   *
   * The tombstone's evidence is REFRESHED to the suppressing run's rather than left frozen:
   * the defect being repaired is a row serving evidence its own gates no longer support, and
   * a stale tombstone is that defect with a different status column. The refreshed row shows
   * the failing gate that suppressed it. Excluding it from the list read instead was
   * rejected — `listRecommendations` returns DISMISSED rows deliberately, so the reader can
   * see the counterevidence they dismissed it over, and hiding it would trade one silent
   * omission for another (§19: an understated report is the defect).
   *
   * Two statements, each atomic, and no read-then-branch: `deleteMany` removes the row only
   * when it is not DISMISSED, and the `updateMany` that follows can only reach a row the
   * delete deliberately left behind. A find-then-write would reopen exactly the race the
   * UNIQUE fingerprint exists to close.
   */
  async withdrawOnSuppression(sighting: RecommendationSighting): Promise<WithdrawalResult> {
    const fingerprint = recommendationFingerprint({
      analyzerId: sighting.analyzerId,
      analyzerVersion: sighting.analyzerVersion,
      groupKey: sighting.groupKey,
    });

    const deleted = await this.prisma.client.recommendation.deleteMany({
      where: { fingerprint, status: { not: 'DISMISSED' } },
    });

    if (deleted.count > 0) return 'DELETED';

    const kept = await this.prisma.client.recommendation.updateMany({
      where: { fingerprint },
      data: resightedColumns(sighting),
    });

    return kept.count > 0 ? 'KEPT_DISMISSED' : 'ABSENT';
  }

  /**
   * §21's `PATCH /v1/recommendations/:id/status`, as one statement that also answers "did
   * that row exist".
   *
   * `updateManyAndReturn` rather than `update`: `update` throws `P2025` for a missing row,
   * and catching it would mean matching on a Prisma error code — a Prisma type crossing into
   * control flow, which `CLAUDE.md` ## Types rules out. An empty array is the same answer
   * without the import.
   *
   * `statusNote` is written on every call, `null` when no note was given, rather than left
   * alone when the caller omits one. A note explains the CURRENT status; carrying the note
   * from a previous DISMISS onto a later re-open would attach a stale justification to a
   * decision nobody made with it.
   */
  async setStatus(
    id: string,
    status: RecommendationStatus,
    note: string | null,
    changedAt: Date,
  ): Promise<RecommendationRecord | RepeatedFailedActionRecord | undefined> {
    const rows = await this.prisma.client.recommendation.updateManyAndReturn({
      where: { id },
      data: { status, statusNote: note, statusChangedAt: changedAt },
    });

    const row = rows[0];

    return row === undefined ? undefined : toAnyRecommendationRecord(row);
  }
}
