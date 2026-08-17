import type {
  ContextConcentration,
  Counterexample,
  DecisionAggregate,
  DecisionRecord,
  ExclusionCounts,
  GroupKey,
  OptionCount,
} from './types';

/**
 * Decision aggregation (MVP_PLAN_V3.md §18).
 *
 * Pure functions only. No I/O, no clock, no configuration — thresholds belong to `./gates`,
 * not to the measurement.
 *
 * Graduated from `spike/aggregate.ts` with two corrections, neither cosmetic:
 *
 * 1. `dominantOptionAttestedSuccessRate` is computed over the DOMINANT option's own attested
 *    decisions, never blended across every option. The spike computed it group-wide, which
 *    disagrees with §19's per-option reading on D1, D3 and D6 — D3 is 43/47 over the YES
 *    rows, not 46/50 group-wide.
 * 2. `counterexamples` is dominant-option FAILURES plus minority-option SUCCESSES (§20.1),
 *    not every minority-selected row. The spike's reading counted minority rows regardless
 *    of outcome, which undercounts D1 (1 instead of 3), D3 (3 instead of 7), D6 (2 instead
 *    of 22) and four other rows. `minorityContextConcentration` is a DIFFERENT population —
 *    a group-by over every minority-selected row, outcome irrelevant — and is computed
 *    independently, never derived from `counterexamples` (§18 "minorityContextConcentration").
 */

/**
 * The corrected group key.
 *
 * `contextKey` is deliberately NOT a member. It is a dimension measured *within* a group;
 * including it would pin `distinctContextKeyCount` to 1 and make G2 unsatisfiable (§18
 * "Group key").
 */
export function groupKeyOf(record: DecisionRecord): GroupKey {
  return {
    workflowName: record.workflowName,
    workflowVersion: record.workflowVersion,
    decisionType: record.decisionType,
    contextKeyVersion: record.contextKeyVersion,
  };
}

export function serializeGroupKey(key: GroupKey): string {
  return [key.workflowName, key.workflowVersion, key.decisionType, key.contextKeyVersion].join(' ');
}

/**
 * A decision is eligible unless its run went STALE or its caller supplied no contextKey.
 *
 * Both exclusions are load-bearing. Silently including an un-keyed decision under a default
 * key is how fake dominance gets manufactured; including STALE runs counts decisions whose
 * outcomes were never resolved. A record that is both stale and un-keyed is counted once,
 * as `staleRun`.
 */
export function isEligible(record: DecisionRecord): boolean {
  return !record.runIsStale && record.contextKey !== null;
}

/** Aggregate every group present in `records`, ordered deterministically. */
export function aggregateAll(records: readonly DecisionRecord[]): readonly DecisionAggregate[] {
  const byKey = new Map<string, { key: GroupKey; records: DecisionRecord[] }>();

  for (const record of records) {
    const key = groupKeyOf(record);
    const serialized = serializeGroupKey(key);
    const bucket = byKey.get(serialized) ?? { key, records: [] };
    bucket.records.push(record);
    byKey.set(serialized, bucket);
  }

  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, bucket]) => aggregateGroup(bucket.key, bucket.records));
}

export function aggregateGroup(
  key: GroupKey,
  records: readonly DecisionRecord[],
): DecisionAggregate {
  const eligible = records.filter(isEligible);
  const excluded = countExclusions(records);

  const sampleCount = eligible.length;
  const distinctContextKeyCount = new Set(eligible.map((r) => r.contextKey)).size;
  const optionDistribution = distribution(eligible, sampleCount);
  const dominantOption = optionDistribution[0]?.option ?? null;
  const dominancePercentage = optionDistribution[0]?.share ?? 0;

  // Selection is observed even when outcome is not, so UNKNOWN-outcome decisions count
  // toward sampleCount and dominance but never toward a success denominator. Excluding them
  // from sampleCount would pin outcomeCoverage at 100% and make G5 unsatisfiable (§18
  // "Explicit denominators").
  const attested = eligible.filter((r) => r.outcome !== 'UNKNOWN');

  // §19 evaluates G4 on the dominant option specifically — the denominator is the dominant
  // option's OWN attested decisions, not every attested decision in the group.
  const dominantAttested = attested.filter((r) => r.selectedOption === dominantOption);
  const dominantSuccesses = dominantAttested.filter((r) => r.outcome === 'SUCCESS').length;

  const counterexamples = extractCounterexamples(eligible, dominantOption);
  const minorityRecords = minoritySelections(eligible, dominantOption);

  return {
    key,
    sampleCount,
    distinctContextKeyCount,
    optionDistribution,
    dominantOption,
    dominancePercentage,
    attestedCount: attested.length,
    outcomeCoverage: sampleCount === 0 ? 0 : attested.length / sampleCount,
    // Null, never zero. A dominant option with no attested outcomes has an UNDEFINED
    // success rate (§18 "Explicit denominators") — rendering it as 0.0% is the lie §2
    // forbids.
    dominantOptionAttestedSuccessRate:
      dominantAttested.length === 0 ? null : dominantSuccesses / dominantAttested.length,
    counterexamples,
    minorityContextConcentration: concentration(minorityRecords),
    excluded,
  };
}

function countExclusions(records: readonly DecisionRecord[]): ExclusionCounts {
  let staleRun = 0;
  let missingContextKey = 0;
  for (const record of records) {
    if (record.runIsStale) staleRun += 1;
    else if (record.contextKey === null) missingContextKey += 1;
  }
  return { staleRun, missingContextKey };
}

/** Descending by count, then ascending by option name so ties are deterministic. */
function distribution(eligible: readonly DecisionRecord[], total: number): readonly OptionCount[] {
  const counts = new Map<string, number>();
  for (const record of eligible) {
    counts.set(record.selectedOption, (counts.get(record.selectedOption) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([option, count]) => ({ option, count, share: total === 0 ? 0 : count / total }))
    .sort((a, b) => b.count - a.count || (a.option < b.option ? -1 : 1));
}

/** Every eligible decision that did NOT select the dominant option. The population
 *  `minorityContextConcentration` groups over — outcome irrelevant. */
function minoritySelections(
  eligible: readonly DecisionRecord[],
  dominantOption: string | null,
): readonly DecisionRecord[] {
  if (dominantOption === null) return [];
  return eligible.filter((r) => r.selectedOption !== dominantOption);
}

/**
 * Counterexamples (§20.1): dominant-option FAILURES plus minority-option SUCCESSES. This is
 * the evidence against the recommendation — a dominant-option failure undercuts the claim
 * directly, and a minority-option success shows the road not taken would also have worked.
 *
 * A minority-option FAILURE is not evidence against the recommendation — it is evidence
 * FOR it — and is therefore not a counterexample, even though it is a minority row. That is
 * exactly why this population differs from `minorityContextConcentration`'s (§18
 * "minorityContextConcentration": "Do not compute one from the other").
 *
 * Never sampled, never truncated, never summarized into a percentage.
 */
function extractCounterexamples(
  eligible: readonly DecisionRecord[],
  dominantOption: string | null,
): readonly Counterexample[] {
  if (dominantOption === null) return [];

  const dominantFailures = eligible.filter(
    (r) => r.selectedOption === dominantOption && r.outcome === 'FAILURE',
  );
  const minoritySuccesses = eligible.filter(
    (r) => r.selectedOption !== dominantOption && r.outcome === 'SUCCESS',
  );

  return [...dominantFailures, ...minoritySuccesses]
    .map((r) => ({
      decisionId: r.decisionId,
      runId: r.runId,
      // Safe: eligibility already excluded null contextKeys.
      contextKey: r.contextKey as string,
      selectedOption: r.selectedOption,
      outcome: r.outcome,
    }))
    .sort((a, b) =>
      a.contextKey < b.contextKey
        ? -1
        : a.contextKey > b.contextKey
          ? 1
          : a.decisionId < b.decisionId
            ? -1
            : 1,
    );
}

/**
 * Where the minority sits (§18 "minorityContextConcentration"). Grouped over EVERY
 * minority-selected record, regardless of outcome — a minority row that failed is still
 * evidence about where the escape hatch goes, even though it is not a counterexample.
 *
 * A minority concentrated in one context names the escape-hatch condition outright; a
 * minority scattered across many contexts says the branch is responding to something
 * `contextKey` does not capture.
 */
function concentration(
  minorityRecords: readonly DecisionRecord[],
): readonly ContextConcentration[] {
  if (minorityRecords.length === 0) return [];
  const counts = new Map<string, number>();
  for (const record of minorityRecords) {
    // Safe: eligibility already excluded null contextKeys.
    const contextKey = record.contextKey as string;
    counts.set(contextKey, (counts.get(contextKey) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([contextKey, count]) => ({ contextKey, count, share: count / minorityRecords.length }))
    .sort((a, b) => b.count - a.count || (a.contextKey < b.contextKey ? -1 : 1));
}
