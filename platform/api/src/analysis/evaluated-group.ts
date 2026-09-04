import type {
  AnalyzerConfig,
  ContextConcentration as EngineContextConcentration,
  Counterexample as EngineCounterexample,
  DecisionAggregate,
  ExclusionCounts as EngineExclusionCounts,
  GateEvaluation,
  GateResult as EngineGateResult,
  GroupKey as EngineGroupKey,
  OptionCount as EngineOptionCount,
  Outcome as EngineOutcome,
} from '@lengentic/analysis-engine';
import type {
  AnalyzerConfigSnapshot,
  ContextConcentration,
  Counterexample,
  EvaluatedGroup,
  ExclusionCounts,
  GateResult,
  GateResults,
  OptionCount,
  RecommendationEvidence,
  RecommendationGroupKey,
  RecommendationOutcome,
} from '@lengentic/shared';

/**
 * **The engine-output-to-wire mapper.** `p5.analysis-endpoint` owns it, and it is written out
 * field by field rather than inferred.
 *
 * The two sides are deliberately unlinked. `platform/analysis-engine` is an in-process
 * vocabulary for pure functions and imports nothing; `platform/shared/schema/recommendation.ts`
 * is the only wire contract (`CLAUDE.md` ## Types) and deliberately does not import the engine,
 * because a shared package that reached into it would drag an analysis dependency into every
 * SDK consumer. Nothing therefore keeps them in step on its own — this file is the joint, and
 * writing each field out is what makes a shape change on either side a typecheck failure here
 * rather than a wrong number at the demo.
 *
 * A spread or a structural cast would compile today and keep compiling after the engine grew a
 * field the wire has no column for, or renamed one the wire still reads. `no-object-spread` is
 * not a rule anywhere; this is DATA-1's persistence-edge argument applied to a module edge, and
 * the same rule `runs.service.ts` and `recommendations.service.ts` already follow.
 */

/** §18's four-member group key. `contextKey` is not a member — it is measured *within* a group. */
export function toWireGroupKey(key: EngineGroupKey): RecommendationGroupKey {
  return {
    workflowName: key.workflowName,
    workflowVersion: key.workflowVersion,
    decisionType: key.decisionType,
    contextKeyVersion: key.contextKeyVersion,
  };
}

/**
 * One gate result. `status` crosses as a `switch` for the same reason `analysis-source.ts`
 * maps its enums that way: the two `GateStatus` vocabularies are identical today and each
 * transcribes §19 independently, so a member added to one and not the other must fail here by
 * name rather than assign silently.
 */
export function toWireGateResult(gate: EngineGateResult): GateResult {
  return {
    id: toWireGateId(gate.id),
    status: toWireGateStatus(gate.status),
    comparison: gate.comparison,
  };
}

function toWireGateId(id: EngineGateResult['id']): GateResult['id'] {
  switch (id) {
    case 'G1_sample_count':
      return 'G1_sample_count';
    case 'G2_context_diversity':
      return 'G2_context_diversity';
    case 'G3_dominance':
      return 'G3_dominance';
    case 'G4_outcome_success':
      return 'G4_outcome_success';
    case 'G5_outcome_coverage':
      return 'G5_outcome_coverage';
  }
}

/** §19's two verdicts. Same exhaustiveness argument as `toWireGateStatus`. */
function toWireVerdict(verdict: GateEvaluation['verdict']): EvaluatedGroup['verdict'] {
  switch (verdict) {
    case 'CANDIDATE':
      return 'CANDIDATE';
    case 'SUPPRESSED':
      return 'SUPPRESSED';
  }
}

function toWireGateStatus(status: EngineGateResult['status']): GateResult['status'] {
  switch (status) {
    case 'PASS':
      return 'PASS';
    case 'FAIL':
      return 'FAIL';
    case 'NOT_APPLICABLE':
      return 'NOT_APPLICABLE';
  }
}

/**
 * One result per `GATE_IDS` member, in `GATE_IDS` order.
 *
 * The order is not re-derived here: `evaluateGates` already fixes it to `GATE_IDS`, and
 * `GateResultsSchema` refuses an array that is the wrong length or out of order on every
 * parse. Re-sorting here would hide a producer that got it wrong from the one check that
 * exists to catch it.
 */
export function toWireGates(gates: readonly EngineGateResult[]): GateResults {
  return gates.map(toWireGateResult);
}

/**
 * The engine's `Outcome` narrowed to the wire's `RecommendationOutcome`.
 *
 * §20.1 defines a counterexample as a dominant-option FAILURE or a minority-option SUCCESS, so
 * `UNKNOWN` names neither and `extractCounterexamples` cannot emit one. The wire encodes that
 * by admitting only two values.
 *
 * The unreachable branch throws rather than dropping the row. Silently filtering it would
 * delete counterevidence, and `CLAUDE.md` ## Product claims has no degraded mode for that —
 * "we found no counterevidence" and "we could not represent this counterevidence" must not
 * become the same response. A 500 says the producer broke its own contract, which is true.
 */
export function toWireCounterexampleOutcome(outcome: EngineOutcome): RecommendationOutcome {
  switch (outcome) {
    case 'SUCCESS':
      return 'SUCCESS';
    case 'FAILURE':
      return 'FAILURE';
    case 'UNKNOWN':
      throw new Error('§20.1: a counterexample outcome is SUCCESS or FAILURE, never UNKNOWN');
  }
}

export function toWireCounterexample(counterexample: EngineCounterexample): Counterexample {
  return {
    decisionId: counterexample.decisionId,
    runId: counterexample.runId,
    contextKey: counterexample.contextKey,
    selectedOption: counterexample.selectedOption,
    outcome: toWireCounterexampleOutcome(counterexample.outcome),
  };
}

export function toWireCounterexamples(
  counterexamples: readonly EngineCounterexample[],
): Counterexample[] {
  return counterexamples.map(toWireCounterexample);
}

export function toWireOptionCount(option: EngineOptionCount): OptionCount {
  return { option: option.option, count: option.count, share: option.share };
}

export function toWireContextConcentration(
  concentration: EngineContextConcentration,
): ContextConcentration {
  return {
    contextKey: concentration.contextKey,
    count: concentration.count,
    share: concentration.share,
  };
}

export function toWireExclusionCounts(excluded: EngineExclusionCounts): ExclusionCounts {
  return { staleRun: excluded.staleRun, missingContextKey: excluded.missingContextKey };
}

/**
 * The thresholds in force, as §21's `configSnapshot`.
 *
 * `AnalyzerConfig` and `AnalyzerConfigSnapshot` mirror each other field for field and are
 * declared in two packages that do not import each other; this is the only place that mirror
 * is checked.
 */
export function toWireConfigSnapshot(config: AnalyzerConfig): AnalyzerConfigSnapshot {
  return {
    minSampleCount: config.minSampleCount,
    minDistinctContexts: config.minDistinctContexts,
    dominanceThreshold: config.dominanceThreshold,
    successThreshold: config.successThreshold,
    coverageThreshold: config.coverageThreshold,
  };
}

/**
 * §21's `evidence` — everything §21's required output shape renders except the group key, the
 * counterexamples and the note.
 *
 * `gates` is an input rather than a field of the aggregate because the engine keeps them apart:
 * `aggregateGroup` produces the aggregate and `evaluateGates` produces the evaluation, and the
 * gates depend on a config the aggregate never sees.
 *
 * `dominantOptionAttestedSuccessRate` crosses as `null`, never coerced to `0`. Null is not
 * zero: a group with nothing attested for its dominant option has an *unknown* rate, and the
 * Dashboard renders `N/A` from exactly this null (a 5b Definition-of-Done line). A `?? 0` here
 * would manufacture the `0.0%` the plan forbids one layer before any renderer could refuse it.
 */
export function toWireEvidence(
  aggregate: DecisionAggregate,
  gates: readonly EngineGateResult[],
): RecommendationEvidence {
  return {
    sampleCount: aggregate.sampleCount,
    distinctContextKeyCount: aggregate.distinctContextKeyCount,
    optionDistribution: aggregate.optionDistribution.map(toWireOptionCount),
    dominantOption: aggregate.dominantOption,
    dominancePercentage: aggregate.dominancePercentage,
    attestedCount: aggregate.attestedCount,
    outcomeCoverage: aggregate.outcomeCoverage,
    dominantOptionAttestedSuccessRate: aggregate.dominantOptionAttestedSuccessRate,
    minorityContextConcentration: aggregate.minorityContextConcentration.map(
      toWireContextConcentration,
    ),
    excluded: toWireExclusionCounts(aggregate.excluded),
    gates: toWireGates(gates),
  };
}

/**
 * One evaluated group on the wire — emitted or not.
 *
 * `recommendationId` is an input, not something this function can derive: a CANDIDATE's id is
 * assigned by the persistence layer, and a SUPPRESSED group has none because §22 persists no
 * entity for it. `EvaluatedGroupSchema` holds the biconditional — a CANDIDATE with a null id,
 * or a SUPPRESSED group with a non-null one, fails to parse.
 *
 * `dominantOptionAttestedSuccessRate` is the one evidence number that crosses onto a group
 * that was never persisted, and it crosses as `null`, never `?? 0`, for the same reason
 * `toWireEvidence` refuses the coercion. It is here because the SUPPRESSED group is the ONLY
 * place the null is producible: a persisted row is a CANDIDATE by construction, and a null
 * rate forces G4 NOT_APPLICABLE → coverage ≤ 1 - dominance ≤ 10% → G5 FAIL → SUPPRESSED. So
 * without this field the Dashboard's `N/A` had no live path at all (Tester, 5b phase gate,
 * FINDING 3: `N/A` rendered 0 times against the real API).
 *
 * `verdict` and `failedGates` are copied from the engine's evaluation rather than recomputed.
 * Recomputing them would let this mapper and the engine disagree about §19's reporting rule
 * while both looked correct in isolation; copying makes the engine the single producer, and
 * `EvaluatedGroupSchema`'s `superRefine` re-derives both from `gates` on every parse as the
 * independent check.
 */
export function toEvaluatedGroup(
  aggregate: DecisionAggregate,
  evaluation: GateEvaluation,
  recommendationId: string | null,
): EvaluatedGroup {
  return {
    groupKey: toWireGroupKey(aggregate.key),
    verdict: toWireVerdict(evaluation.verdict),
    failedGates: evaluation.failedGates.map(toWireGateId),
    gates: toWireGates(evaluation.gates),
    dominantOptionAttestedSuccessRate: aggregate.dominantOptionAttestedSuccessRate,
    recommendationId,
  };
}
