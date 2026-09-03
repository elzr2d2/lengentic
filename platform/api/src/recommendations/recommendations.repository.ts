import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  AnalyzerConfigSnapshotSchema,
  CounterexampleSchema,
  RecommendationEvidenceSchema,
  type RecommendationStatus,
} from '@lengentic/shared';
import { z } from 'zod';
import type { PrismaClient } from '@lengentic/database';

import { PrismaService } from '../prisma/prisma.service';
import { recommendationFingerprint } from './fingerprint';
import type { RecommendationRecord, RecommendationSighting } from './recommendation-record';

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

export function toRecommendationRecord(row: RecommendationRow): RecommendationRecord {
  return {
    id: row.id,
    category: row.category,
    analyzerId: row.analyzerId,
    analyzerVersion: row.analyzerVersion,
    groupKey: {
      workflowName: row.workflowName,
      workflowVersion: row.workflowVersion,
      decisionType: row.decisionType,
      contextKeyVersion: row.contextKeyVersion,
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

function toJsonInput(value: unknown): RecommendationJsonInput {
  return value as RecommendationJsonInput;
}

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

    const resighted = {
      configSnapshot: toJsonInput(sighting.configSnapshot),
      sourceWatermark: sighting.sourceWatermark,
      evidence: toJsonInput(sighting.evidence),
      counterexamples: toJsonInput(sighting.counterexamples),
      lastSeenAt: sighting.observedAt,
    };

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

  async findById(id: string): Promise<RecommendationRecord | undefined> {
    const row = await this.prisma.client.recommendation.findUnique({ where: { id } });

    return row === null ? undefined : toRecommendationRecord(row);
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
  ): Promise<RecommendationRecord | undefined> {
    const rows = await this.prisma.client.recommendation.updateManyAndReturn({
      where: { id },
      data: { status, statusNote: note, statusChangedAt: changedAt },
    });

    const row = rows[0];

    return row === undefined ? undefined : toRecommendationRecord(row);
  }
}
