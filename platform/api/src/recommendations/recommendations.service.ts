import { Inject, Injectable } from '@nestjs/common';
import type {
  Recommendation,
  RecommendationListView,
  RecommendationStatusPatch,
  RecommendationsListQuery,
  RepeatedFailedActionListView,
  RepeatedFailedActionRecommendation,
} from '@lengentic/shared';

import { CLOCK, type Clock } from '../common/clock';
import type {
  RecommendationRecord,
  RecommendationSighting,
  RepeatedFailedActionRecord,
  RepeatedFailedActionSighting,
  WithdrawalResult,
} from './recommendation-record';
import { RecommendationsRepository } from './recommendations.repository';

/**
 * §21's entity, as the rest of the API sees it: record what an analysis run saw, and change
 * a recommendation's status.
 *
 * The `Date` → ISO mapping lives here rather than in the repository, the same split
 * `runs.service.ts` uses: the repository owns rows, this owns the wire.
 *
 * `undefined` for an unknown id rather than a thrown 404 — whether that is a status code is
 * the controller's decision, and this service is also the seam `p5.analysis-endpoint` calls
 * with no HTTP request in sight.
 */
@Injectable()
export class RecommendationsService {
  constructor(
    private readonly repository: RecommendationsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * One CANDIDATE group from one analysis run.
   *
   * Only a CANDIDATE reaches here. A SUPPRESSED group is returned in the analysis response
   * and is never persisted as an entity — there is no suppression table and no suppression
   * history in the MVP (§22) — so there is deliberately no method on this service that could
   * store one.
   */
  async recordSighting(sighting: RecommendationSighting): Promise<Recommendation> {
    return toRecommendation(await this.repository.recordSighting(sighting));
  }

  /**
   * One SUPPRESSED group from one analysis run — the same payload `recordSighting` takes,
   * because the group key it identifies the row by is the same, and because a kept tombstone
   * has to be refreshed with the run's own evidence.
   *
   * Named for what it does to a CLAIM, not for what it stores: nothing here writes a
   * suppression. It withdraws a recommendation the analyzer no longer stands behind, and the
   * one row it does not remove is a DISMISSED tombstone, which asserts no recommendation
   * either (`docs/decisions/0015`, and `withdrawOnSuppression` in the repository for why).
   *
   * No `Recommendation` comes back. A withdrawn row is not a recommendation to return, and a
   * tombstone is not one either; the analysis response names `recommendationId: null` for
   * this group whatever happened here, and `EvaluatedGroupSchema` refuses anything else.
   */
  async withdrawOnSuppression(sighting: RecommendationSighting): Promise<WithdrawalResult> {
    return this.repository.withdrawOnSuppression(sighting);
  }

  /**
   * §25 beats 4 and 5's read: one page of recommendations, evidence and counterexamples
   * included.
   *
   * This method did not exist when `p5.rec-persistence` shipped — §21 specifies only the
   * PATCH, so writing a read against no caller would have been this lane choosing the next
   * lane's signature. The caller now exists and the envelope is frozen
   * (`RecommendationListViewSchema`), which is what changed.
   *
   * `limit + 1` rows are read and the extra is dropped, the same trick `runs.service.ts`
   * uses: `hasMore` is then a fact about rows that came back rather than a second
   * `COUNT(*)` scan, and `records.length === limit` — which is simply wrong on the exact
   * last page — is never asked.
   */
  async list(query: RecommendationsListQuery): Promise<RecommendationListView> {
    const records = await this.repository.listRecommendations(query.limit + 1, query.offset);
    const page = records.slice(0, query.limit);

    return {
      recommendations: page.map(toRecommendation),
      limit: query.limit,
      offset: query.offset,
      hasMore: records.length > query.limit,
    };
  }

  /**
   * `list` for §20.2 rows: the same page arithmetic over the second category.
   */
  async listRepeatedFailedActions(
    query: RecommendationsListQuery,
  ): Promise<RepeatedFailedActionListView> {
    const records = await this.repository.listRepeatedFailedActions(query.limit + 1, query.offset);
    const page = records.slice(0, query.limit);

    return {
      recommendations: page.map(toRepeatedFailedActionRecommendation),
      limit: query.limit,
      offset: query.offset,
      hasMore: records.length > query.limit,
    };
  }

  /** One emitted §20.2 streak from one analysis run — `recordSighting`'s counterpart. */
  async recordRepeatedFailedActionSighting(
    sighting: RepeatedFailedActionSighting,
  ): Promise<RepeatedFailedActionRecommendation> {
    return toRepeatedFailedActionRecommendation(
      await this.repository.recordRepeatedFailedActionSighting(sighting),
    );
  }

  /**
   * Withdraws every persisted, non-DISMISSED §20.2 row whose fingerprint is not in `emitted`
   * — `withdrawOnSuppression`'s counterpart. Returns how many rows were removed.
   */
  async withdrawRepeatedFailedActionsExcept(emitted: readonly string[]): Promise<number> {
    return this.repository.withdrawRepeatedFailedActionsExcept(emitted);
  }

  async setStatus(
    id: string,
    patch: RecommendationStatusPatch,
  ): Promise<Recommendation | RepeatedFailedActionRecommendation | undefined> {
    const record = await this.repository.setStatus(
      id,
      patch.status,
      patch.note ?? null,
      this.clock.now(),
    );

    if (record === undefined) return undefined;

    return record.category === 'REPEATED_FAILED_ACTION'
      ? toRepeatedFailedActionRecommendation(record)
      : toRecommendation(record);
  }
}

/**
 * Every field is copied across explicitly rather than spread — the same rule the four
 * mappers in `runs.service.ts` follow, and for the same reason: a spread compiles and also
 * carries whatever column the next migration adds straight onto the wire. DATA-1's
 * persistence edge is only an edge if something has to be written down to cross it.
 *
 * `counterexamples` is copied into a fresh array: the record types it `readonly
 * Counterexample[]`, and the wire's mutable array would otherwise be the record's own,
 * mutable through the response object.
 */
export function toRecommendation(record: RecommendationRecord): Recommendation {
  return {
    id: record.id,
    category: record.category,
    analyzerId: record.analyzerId,
    analyzerVersion: record.analyzerVersion,
    groupKey: { ...record.groupKey },
    configSnapshot: { ...record.configSnapshot },
    sourceWatermark: record.sourceWatermark.toISOString(),
    fingerprint: record.fingerprint,
    evidence: record.evidence,
    counterexamples: [...record.counterexamples],
    firstSeenAt: record.firstSeenAt.toISOString(),
    lastSeenAt: record.lastSeenAt.toISOString(),
    status: record.status,
    statusNote: record.statusNote,
    statusChangedAt: record.statusChangedAt === null ? null : record.statusChangedAt.toISOString(),
  };
}

/** `toRecommendation` for §20.2: every field copied across explicitly, for the same reason. */
export function toRepeatedFailedActionRecommendation(
  record: RepeatedFailedActionRecord,
): RepeatedFailedActionRecommendation {
  return {
    id: record.id,
    category: record.category,
    analyzerId: record.analyzerId,
    analyzerVersion: record.analyzerVersion,
    actionKey: { ...record.actionKey },
    configSnapshot: { ...record.configSnapshot },
    sourceWatermark: record.sourceWatermark.toISOString(),
    fingerprint: record.fingerprint,
    evidence: { ...record.evidence, toolCallIds: [...record.evidence.toolCallIds] },
    counterexamples: [...record.counterexamples],
    firstSeenAt: record.firstSeenAt.toISOString(),
    lastSeenAt: record.lastSeenAt.toISOString(),
    status: record.status,
    statusNote: record.statusNote,
    statusChangedAt: record.statusChangedAt === null ? null : record.statusChangedAt.toISOString(),
  };
}
