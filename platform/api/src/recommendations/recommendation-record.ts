import type {
  AnalyzerConfigSnapshot,
  Counterexample,
  RecommendationCategory,
  RecommendationEvidence,
  RecommendationGroupKey,
  RecommendationStatus,
} from '@lengentic/shared';

/**
 * The domain shape of one persisted recommendation, on the API's side of the persistence
 * edge (`docs/ENGINEERING_STANDARDS.md` DATA-1, `CLAUDE.md` ## Types).
 *
 * Instants are `Date` here and ISO strings on the wire; the JSON columns are already the
 * wire's own shapes, parsed back out of the row. No Prisma type appears in this file, and
 * none crosses out of `recommendations.repository.ts` — the `to*` mappers there are the
 * edge, and nothing past them has ever seen a row.
 */
export interface RecommendationRecord {
  readonly id: string;
  readonly category: RecommendationCategory;
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly groupKey: RecommendationGroupKey;
  readonly configSnapshot: AnalyzerConfigSnapshot;
  readonly sourceWatermark: Date;
  readonly fingerprint: string;
  readonly evidence: RecommendationEvidence;
  /** Always present; may be empty. Never omitted — `CLAUDE.md` ## Product claims. */
  readonly counterexamples: readonly Counterexample[];
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly status: RecommendationStatus;
  readonly statusNote: string | null;
  readonly statusChangedAt: Date | null;
}

/**
 * What one analysis run asserts about one CANDIDATE group.
 *
 * There is no `status`, no `firstSeenAt` and no `id` here on purpose: a re-analysis has no
 * opinion about any of the three. `status` is owned by the human (§21's PATCH), `firstSeenAt`
 * is owned by the first sighting, and the id is assigned once. Leaving them off the write
 * shape is what makes "a DISMISSED recommendation stays dismissed across re-analysis" a
 * property of the type rather than of the repository remembering not to write them.
 *
 * `observedAt` is the analysis run's single server-clock reading — one reading for the whole
 * run, so two recommendations emitted by one analysis cannot disagree about when it happened.
 */
/**
 * What happened to the persisted row of a group an analysis run has just SUPPRESSED.
 *
 * - `DELETED` — the row existed and was removed. §22: suppression is not an entity, and a
 *   claim the analyzer has withdrawn must not stay in the table consumers read.
 * - `KEPT_DISMISSED` — a human had dismissed it, so the row is kept as a tombstone with its
 *   evidence refreshed to the suppressing run's (`docs/decisions/0015`). §21's "DISMISSED
 *   stays DISMISSED" survives a suppression excursion; a DISMISSED row asserts no
 *   recommendation, so keeping it does not make suppression an entity.
 * - `ABSENT` — there was nothing to withdraw, which is the ordinary case: most suppressed
 *   groups were never candidates.
 *
 * Three values rather than a boolean or a void: "nothing was there" and "something was kept
 * on purpose" are different facts about the same call, and a caller that could not tell them
 * apart could not report either.
 */
export type WithdrawalResult = 'DELETED' | 'KEPT_DISMISSED' | 'ABSENT';

export interface RecommendationSighting {
  readonly category: RecommendationCategory;
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly groupKey: RecommendationGroupKey;
  readonly configSnapshot: AnalyzerConfigSnapshot;
  readonly sourceWatermark: Date;
  readonly evidence: RecommendationEvidence;
  readonly counterexamples: readonly Counterexample[];
  readonly observedAt: Date;
}
