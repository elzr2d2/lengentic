import { Inject, Injectable } from '@nestjs/common';
import {
  aggregateAll,
  evaluateGates,
  type AnalyzerConfig,
  type DecisionAggregate,
  type GateEvaluation,
} from '@lengentic/analysis-engine';
import {
  AnalysisRunResponseSchema,
  type AnalysisRunResponse,
  type EvaluatedGroup,
} from '@lengentic/shared';

import { CLOCK, type Clock } from '../common/clock';
import { RecommendationsService } from '../recommendations/recommendations.service';
import { STALE_THRESHOLD_MS } from '../runs/stale-threshold.provider';
import { ANALYZER_CONFIG } from './analyzer-config.provider';
import { DETERMINISTIC_CANDIDATE_ANALYZER } from './analyzer-identity';
import { sourceWatermarkOf, toEngineDecisionRecords } from './analysis-source';
import { AnalysisRepository } from './analysis.repository';
import {
  toEvaluatedGroup,
  toWireConfigSnapshot,
  toWireCounterexamples,
  toWireEvidence,
  toWireGroupKey,
} from './evaluated-group';

/**
 * §22's analysis run: read every decision, aggregate (§18), gate (§19), persist the
 * CANDIDATEs (§21), return every evaluated group (§22).
 *
 * ## Explicit and on demand
 *
 * Nothing here polls, schedules, retries or enqueues, and nothing on the ingest path calls it.
 * §22 is a list of things that must not exist — no Redis, no BullMQ, no worker service, no job
 * table, no in-process queue — and "not inline with ingestion" is satisfied by this being
 * reachable only from `POST /v1/analysis/run`.
 *
 * ## One clock reading for the whole run
 *
 * `observedAt` is taken once, before anything is read, and every recommendation this run
 * records carries it. Two recommendations emitted by one analysis cannot then disagree about
 * when that analysis happened, and `firstSeenAt`/`lastSeenAt` stay comparable across a run.
 * It is also the `now` the STALE rule uses, so a run cannot classify one decision's run as
 * live and a later one's as stale on the strength of the clock advancing mid-loop.
 */
@Injectable()
export class AnalysisService {
  constructor(
    private readonly repository: AnalysisRepository,
    private readonly recommendations: RecommendationsService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STALE_THRESHOLD_MS) private readonly staleThresholdMs: number,
    @Inject(ANALYZER_CONFIG) private readonly config: AnalyzerConfig,
  ) {}

  async run(): Promise<AnalysisRunResponse> {
    const observedAt = this.clock.now();

    const sources = await this.repository.listDecisionsForAnalysis();
    const sourceWatermark = sourceWatermarkOf(sources) ?? observedAt;
    const records = toEngineDecisionRecords(sources, {
      now: observedAt,
      staleThresholdMs: this.staleThresholdMs,
    });

    const evaluatedGroups: EvaluatedGroup[] = [];

    // Sequential, not `Promise.all`. Each iteration may write a row, and §21's dedupe is an
    // `upsert` on a UNIQUE fingerprint — fanning the writes out would buy nothing (the groups
    // are already computed in memory) and would hand Postgres a set of concurrent upserts whose
    // failure mode is a deadlock rather than a result.
    for (const aggregate of aggregateAll(records)) {
      const evaluation = evaluateGates(aggregate, this.config);
      const recommendationId = await this.persistIfCandidate(
        aggregate,
        evaluation,
        sourceWatermark,
        observedAt,
      );

      evaluatedGroups.push(toEvaluatedGroup(aggregate, evaluation, recommendationId));
    }

    // Parsed, not cast, before it leaves this method. `EvaluatedGroupSchema` encodes three
    // invariants no type can carry — §19's "every failing gate, not the first", the verdict
    // biconditional, and §22's "a CANDIDATE names a row and a SUPPRESSED group names none" —
    // and re-derives the first two from `gates` independently of the engine that produced them.
    // A mapper that understated a failure would otherwise reach the Dashboard looking correct;
    // ERR-adjacent, but the reason is `CLAUDE.md` ## Product claims: a wrong claim on the wire
    // is worse than a 500.
    return AnalysisRunResponseSchema.parse({ evaluatedGroups });
  }

  /**
   * §22: only a CANDIDATE becomes a persisted row. A SUPPRESSED group is returned in the
   * response and never persisted — there is no suppression table and no suppression history in
   * the MVP — so this returns `null` for one and writes nothing.
   */
  private async persistIfCandidate(
    aggregate: DecisionAggregate,
    evaluation: GateEvaluation,
    sourceWatermark: Date,
    observedAt: Date,
  ): Promise<string | null> {
    if (evaluation.verdict !== 'CANDIDATE') return null;

    const recommendation = await this.recommendations.recordSighting({
      category: DETERMINISTIC_CANDIDATE_ANALYZER.category,
      analyzerId: DETERMINISTIC_CANDIDATE_ANALYZER.id,
      analyzerVersion: DETERMINISTIC_CANDIDATE_ANALYZER.version,
      groupKey: toWireGroupKey(aggregate.key),
      configSnapshot: toWireConfigSnapshot(this.config),
      sourceWatermark,
      evidence: toWireEvidence(aggregate, evaluation.gates),
      counterexamples: toWireCounterexamples(aggregate.counterexamples),
      observedAt,
    });

    return recommendation.id;
  }
}
