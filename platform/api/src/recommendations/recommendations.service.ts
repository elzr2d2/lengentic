import { Inject, Injectable } from '@nestjs/common';
import type { Recommendation, RecommendationStatusPatch } from '@lengentic/shared';

import { CLOCK, type Clock } from '../common/clock';
import type { RecommendationRecord, RecommendationSighting } from './recommendation-record';
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

  /*
   * There is deliberately no read method here. The list and detail reads the Dashboard needs
   * are `p5.recs-ui`'s consumers and `p5.analysis-endpoint`'s to expose; adding one against
   * no caller would be this lane writing a signature the next lane did not choose, and no
   * packet line asks for it.
   */

  async setStatus(
    id: string,
    patch: RecommendationStatusPatch,
  ): Promise<Recommendation | undefined> {
    const record = await this.repository.setStatus(
      id,
      patch.status,
      patch.note ?? null,
      this.clock.now(),
    );

    return record === undefined ? undefined : toRecommendation(record);
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
