import type {
  ContextConcentration,
  Counterexample,
  Recommendation,
  RecommendationEvidence,
} from '@lengentic/shared';
import { GateTable } from './gate-table';
import { percent, percentOrNotAttested, workflowLabel } from './format';

/**
 * §21's required output shape, and §25 beat 5 — "Show the recommendation, counterexamples
 * included."
 *
 * Every block below is named in §21: the header, the evidence rows, the Gates block, the
 * Suggested action, the Counterexamples with their concentration line, and the Note. None of
 * them is decoration.
 *
 * ## What is deliberately absent
 *
 * No `severity`. §21 removed it because no deterministic calculation for it was ever
 * specified, and an arbitrary label attached to evidence-based output undermines the evidence.
 * The gate results are shown instead, which is the whole substitution §21 asks for.
 */
export function RecommendationCard({ recommendation }: { recommendation: Recommendation }) {
  const { evidence, groupKey } = recommendation;

  return (
    <section className="card">
      <h2 className="card-title">
        <code>{groupKey.decisionType}</code>
      </h2>

      <Row label="Category" value={<span className="value">{recommendation.category}</span>} />
      <Row
        label="Deterministic default candidate"
        value={
          evidence.dominantOption === null ? (
            <span className="note-absent">no dominant option</span>
          ) : (
            <code>{evidence.dominantOption}</code>
          )
        }
      />
      <Row label="Workflow" value={<span className="value">{workflowLabel(groupKey)}</span>} />
      <Row
        label="Status"
        value={
          <span
            className={`status ${recommendation.status === 'OPEN' ? 'status-ok' : 'status-warn'}`}
          >
            {recommendation.status}
          </span>
        }
      />

      <EvidenceRows evidence={evidence} />

      <h3 className="section-title">Gates</h3>
      <ThresholdNote recommendation={recommendation} />
      <GateTable gates={evidence.gates} />

      <h3 className="section-title">Suggested action</h3>
      <SuggestedAction
        dominantOption={evidence.dominantOption}
        hasFailingGate={evidence.gates.some((gate) => gate.status === 'FAIL')}
      />

      <h3 className="section-title">
        Counterexamples ({String(recommendation.counterexamples.length)})
      </h3>
      {/*
        Two components, not one, because they render two DIFFERENT populations
        (`MVP_PLAN_V3.md:967`, `analysis-engine/src/aggregate.ts:158-169` — "Do not compute one
        from the other"). `<Concentration>` used to sit inside the non-empty branch of
        `<Counterexamples>`, which silently dropped the concentration line for every group
        whose minority rows all failed or went unattested — the case where the minority is the
        only minority evidence there is (Reviewer S1 / Tester FINDING 2, 5b phase gate).
      */}
      <Counterexamples counterexamples={recommendation.counterexamples} />
      <Concentration concentration={evidence.minorityContextConcentration} />

      <h3 className="section-title">Note</h3>
      <p className="note">
        LenGentic observes chosen options only. It cannot determine what would have happened had the
        minority option been selected. Review the counterexamples before removing the branch.
      </p>
    </section>
  );
}

function EvidenceRows({ evidence }: { evidence: RecommendationEvidence }) {
  return (
    <>
      <Row label="Samples" value={<span className="value">{String(evidence.sampleCount)}</span>} />
      <Row
        label="Distinct contexts"
        value={<span className="value">{String(evidence.distinctContextKeyCount)}</span>}
      />
      <Row
        label="Distribution"
        value={<span className="value">{distributionLine(evidence)}</span>}
      />
      <Row
        label="Dominance"
        value={<span className="value">{percent(evidence.dominancePercentage)}</span>}
      />
      {/*
        "Attested", never "measured", and `N/A` rather than `0.0%` when the rate is null — the
        caller asserts the outcome, and nothing attested is a different claim from everything
        having failed.
      */}
      <Row
        label="Attested success (dominant option)"
        value={
          <span className="value">
            {percentOrNotAttested(evidence.dominantOptionAttestedSuccessRate)}
          </span>
        }
      />
      <Row
        label="Outcome coverage"
        value={
          <span className="value">
            {percent(evidence.outcomeCoverage)} ({String(evidence.attestedCount)} of{' '}
            {String(evidence.sampleCount)} attested)
          </span>
        }
      />
      <Row
        label="Excluded"
        value={
          <span className="value">
            {String(evidence.excluded.staleRun)} stale run,{' '}
            {String(evidence.excluded.missingContextKey)} missing contextKey
          </span>
        }
      />
    </>
  );
}

/** §21's `Distribution: YES 49 (98.0%) | NO 1 (2.0%)`, in the order the engine reported. */
function distributionLine(evidence: RecommendationEvidence): string {
  if (evidence.optionDistribution.length === 0) return 'no observations';

  return evidence.optionDistribution
    .map((option) => `${option.option} ${String(option.count)} (${percent(option.share)})`)
    .join(' | ');
}

/**
 * §21: "`configSnapshot` matters: a recommendation produced under a 30-sample threshold means
 * something different from one produced under 50, and without the snapshot the difference is
 * invisible." The thresholds are printed beside the gate results for exactly that reason — a
 * PASS is only readable against the bar it cleared.
 *
 * Worded against "the evidence above", never "when this was produced": ADR 0015's tombstone
 * refreshes `configSnapshot` together with `evidence` on every re-sighting
 * (`recommendations.repository.ts`, `resightedColumns`), so on a DISMISSED row the snapshot
 * shown is the suppressing run's, not the run that first produced the row. "When this was
 * produced" is false there; "the evidence above" is true of both a fresh row and a refreshed
 * tombstone because the two are always written together — no conditional needed.
 */
function ThresholdNote({ recommendation }: { recommendation: Recommendation }) {
  const config = recommendation.configSnapshot;

  return (
    <p className="note-inline">
      Thresholds the evidence above was evaluated against: samples &ge;{' '}
      {String(config.minSampleCount)}, distinct contexts &ge; {String(config.minDistinctContexts)},
      dominance &ge; {percent(config.dominanceThreshold)}, attested success &ge;{' '}
      {percent(config.successThreshold)}, outcome coverage &ge; {percent(config.coverageThreshold)}.
    </p>
  );
}

/**
 * §21's suggested-action wording, with the dominant option substituted in — unless the gate
 * table above no longer supports it.
 *
 * `hasFailingGate` reads `evidence.gates` directly rather than `recommendation.status`: the
 * defect this repairs (Reviewer R1, 5b phase gate) is a contradiction inside one rendered
 * card, so the guard has to be true of what the card is showing, not of a column the card
 * does not print. ADR 0015 keeps a DISMISSED row as a tombstone with its evidence refreshed
 * to a SUPPRESSED run's — `dominantOption` can still be non-null there (the ADR's own
 * `flipEvents` scenario: YES, 38 of 70) while `G3_dominance` reads FAIL. Suggesting a default
 * off gates that FAIL is the exact assertion `CLAUDE.md` `## Product claims` forbids:
 * "Recommendations are hypotheses with counterevidence, never assertions."
 */
function SuggestedAction({
  dominantOption,
  hasFailingGate,
}: {
  dominantOption: string | null;
  hasFailingGate: boolean;
}) {
  if (hasFailingGate) {
    return (
      <p className="note-inline">
        A gate above now fails this evidence, so no default is suggested here. Whatever this row's
        Status shows, its evidence no longer supports a recommendation.
      </p>
    );
  }

  if (dominantOption === null) {
    return (
      <p className="note-inline">
        No option dominates this group, so there is no default to suggest.
      </p>
    );
  }

  return (
    <p className="note-inline">
      Consider a deterministic default of <code>{dominantOption}</code> for this decision, with an
      explicit escape hatch for the conditions below. This would remove a model call from the hot
      path while preserving the branch.
    </p>
  );
}

/**
 * The evidence *against* the recommendation — a dominant-option FAILURE or a minority-option
 * SUCCESS (§20.1) — never summarized away.
 *
 * An empty list renders a sentence rather than nothing. `counterexamples` is always present
 * and may be empty (`CLAUDE.md` ## Product claims), so "we found none" is a claim the page has
 * to make out loud; rendering nothing would be indistinguishable from a page that does not
 * report counterevidence at all.
 */
function Counterexamples({ counterexamples }: { counterexamples: readonly Counterexample[] }) {
  if (counterexamples.length === 0) {
    return (
      <p className="note-inline">
        None found in this sample. That is not evidence that none exists — LenGentic only sees the
        options that were chosen.
      </p>
    );
  }

  return (
    <ul className="counterexample-list">
      {counterexamples.map((counterexample) => (
        <CounterexampleRow key={counterexample.decisionId} counterexample={counterexample} />
      ))}
    </ul>
  );
}

function CounterexampleRow({ counterexample }: { counterexample: Counterexample }) {
  return (
    <li className="counterexample">
      <div className="counterexample-head">
        <span className="counterexample-run">
          run <code>{counterexample.runId}</code>
        </span>
        <span
          className={`status ${counterexample.outcome === 'SUCCESS' ? 'status-ok' : 'status-down'}`}
        >
          {counterexample.outcome}
        </span>
      </div>
      <div className="counterexample-meta">
        <span className="field-label">contextKey</span>
        <code>{counterexample.contextKey}</code>
        <span className="field-label">selected</span>
        <code>{counterexample.selectedOption}</code>
      </div>
    </li>
  );
}

/**
 * §25's `Concentration: 1 of 1 minority row in post_refactor_large_diff`.
 *
 * The denominator is the total of the reported concentration counts — every minority row the
 * analyzer placed — rather than `counterexamples.length`, which is a different set: §20.1's
 * counterexamples also include dominant-option failures, and those are not minority rows.
 * Dividing by the wrong denominator would understate exactly how concentrated the minority is,
 * which is the one number the escape hatch is built from.
 *
 * For the same reason it is rendered independently of whether there are any counterexamples
 * at all. A group whose dominant option never failed and whose minority rows are all FAILURE
 * or UNKNOWN has an empty counterexample list and a non-empty concentration, and that is the
 * case where §18's minority block is the ONLY minority evidence on the page.
 *
 * `null` on an empty array, not a "none" sentence: unlike `counterexamples`, an absent
 * concentration is not a claim the page has to make out loud — a group with no minority rows
 * has nothing to concentrate, which its own distribution already says.
 */
function Concentration({ concentration }: { concentration: readonly ContextConcentration[] }) {
  if (concentration.length === 0) return null;

  const total = concentration.reduce((sum, entry) => sum + entry.count, 0);

  return (
    <ul className="concentration-list">
      {concentration.map((entry) => (
        <li key={entry.contextKey}>
          Concentration: {String(entry.count)} of {String(total)} minority row
          {total === 1 ? '' : 's'} in <code>{entry.contextKey}</code>
        </li>
      ))}
    </ul>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      {value}
    </div>
  );
}
