import { Inject, Injectable } from '@nestjs/common';
import {
  aggregateAll,
  evaluateGates,
  MIN_CONSECUTIVE_FAILURES,
  type AnalyzerConfig,
  type DecisionAggregate,
  type GateEvaluation,
} from '@lengentic/analysis-engine';
import {
  AnalysisRunResponseSchema,
  type AnalysisRunResponse,
  type EmittedRepeatedFailedAction,
  type EvaluatedGroup,
} from '@lengentic/shared';

import { CLOCK, type Clock } from '../common/clock';
import { RecommendationsService } from '../recommendations/recommendations.service';
import { STALE_THRESHOLD_MS } from '../runs/stale-threshold.provider';
import { ANALYZER_CONFIG } from './analyzer-config.provider';
import {
  DETERMINISTIC_CANDIDATE_ANALYZER,
  REPEATED_FAILED_ACTION_ANALYZER,
} from './analyzer-identity';
import { sourceWatermarkOf, toEngineDecisionRecords } from './analysis-source';
import { AnalysisRepository } from './analysis.repository';
import {
  toEvaluatedGroup,
  toWireConfigSnapshot,
  toWireCounterexamples,
  toWireEvidence,
  toWireGroupKey,
} from './evaluated-group';
import { findRepeatedFailedActions, toEngineToolCallRecords } from './repeated-failed-source';

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
      const recommendationId = await this.persistOrWithdraw(
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
    const repeatedFailedActions = await this.analyzeRepeatedFailedActions(observedAt);

    return AnalysisRunResponseSchema.parse({ evaluatedGroups, repeatedFailedActions });
  }

  /**
   * §20.2: read every persisted ToolCall, detect, persist what was emitted, withdraw what was
   * not.
   *
   * Persisted through the same `recordSighting`-shaped seam as §20.1 — a single upsert on the
   * UNIQUE fingerprint — so re-running over unchanged data refreshes `lastSeenAt` and adds no
   * row, and a DISMISSED streak stays DISMISSED. A streak is never "SUPPRESSED" the way a
   * §20.1 group is (§20.2 has no gates): a key that stops qualifying is simply absent from
   * this run's emissions, and every persisted, non-DISMISSED row whose fingerprint is not among
   * them is withdrawn, exactly the §22 rule that a claim the analyzer no longer makes must not
   * stay in the table consumers read.
   *
   * Sequential for the reason the §20.1 loop is.
   */
  private async analyzeRepeatedFailedActions(
    observedAt: Date,
  ): Promise<EmittedRepeatedFailedAction[]> {
    const toolCalls = await this.repository.listToolCallsForAnalysis();
    const findings = findRepeatedFailedActions(toEngineToolCallRecords(toolCalls));

    const newest = toolCalls.reduce<Date | undefined>(
      (max, call) => (max === undefined || call.startedAt > max ? call.startedAt : max),
      undefined,
    );
    const sourceWatermark = newest ?? observedAt;

    const emitted: EmittedRepeatedFailedAction[] = [];
    const emittedFingerprints: string[] = [];

    for (const finding of findings) {
      const recommendation = await this.recommendations.recordRepeatedFailedActionSighting({
        category: REPEATED_FAILED_ACTION_ANALYZER.category,
        analyzerId: REPEATED_FAILED_ACTION_ANALYZER.id,
        analyzerVersion: REPEATED_FAILED_ACTION_ANALYZER.version,
        actionKey: finding.actionKey,
        configSnapshot: { minConsecutiveFailures: MIN_CONSECUTIVE_FAILURES },
        sourceWatermark,
        evidence: finding.evidence,
        counterexamples: finding.counterexamples,
        observedAt,
      });

      emittedFingerprints.push(recommendation.fingerprint);
      emitted.push({
        actionKey: finding.actionKey,
        attemptCount: finding.evidence.attemptCount,
        toolCallIds: [...finding.evidence.toolCallIds],
        recommendationId: recommendation.id,
      });
    }

    await this.recommendations.withdrawRepeatedFailedActionsExcept(emittedFingerprints);

    return emitted;
  }

  /**
   * §22: only a CANDIDATE becomes a persisted row, and a SUPPRESSED group is not an entity.
   *
   * The second half of that sentence is a statement about the TABLE, not only about this
   * run's writes. "Do not write a row" and "no row exists" are different claims, and the 5b
   * phase gate found daylight between them: a group persisted while it was a CANDIDATE and
   * later suppressed kept its row, its OPEN status and the superseded evidence of the run
   * that emitted it, and `GET /v1/recommendations` went on serving the claim the analyzer had
   * just refused to make (Tester FINDING 1). So a suppression withdraws the row rather than
   * merely declining to write one — with the DISMISSED tombstone as the single exception
   * (`docs/decisions/0015`).
   *
   * Either way this returns `null`: §22's biconditional says a SUPPRESSED group names no row,
   * and `EvaluatedGroupSchema` refuses the response if it ever did.
   */
  private async persistOrWithdraw(
    aggregate: DecisionAggregate,
    evaluation: GateEvaluation,
    sourceWatermark: Date,
    observedAt: Date,
  ): Promise<string | null> {
    const sighting = {
      category: DETERMINISTIC_CANDIDATE_ANALYZER.category,
      analyzerId: DETERMINISTIC_CANDIDATE_ANALYZER.id,
      analyzerVersion: DETERMINISTIC_CANDIDATE_ANALYZER.version,
      groupKey: toWireGroupKey(aggregate.key),
      configSnapshot: toWireConfigSnapshot(this.config),
      sourceWatermark,
      evidence: toWireEvidence(aggregate, evaluation.gates),
      counterexamples: toWireCounterexamples(aggregate.counterexamples),
      observedAt,
    };

    if (evaluation.verdict !== 'CANDIDATE') {
      await this.recommendations.withdrawOnSuppression(sighting);
      return null;
    }

    const recommendation = await this.recommendations.recordSighting(sighting);

    return recommendation.id;
  }
}
