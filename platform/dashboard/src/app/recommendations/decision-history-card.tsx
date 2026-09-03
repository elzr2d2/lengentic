import type { OptionCount, Recommendation } from '@lengentic/shared';
import { percent, percentOrNotAttested, workflowLabel } from './format';

/**
 * §25 beat 4 — **Decision History**: one row per decision group the analyzer has a persisted
 * claim about, with the numbers the claim rests on.
 *
 * ```text
 * Decision:           run_tests_after_code_change
 * Workflow:           demo-workflow @ a1b2c3d
 * Samples:            48
 * Distinct contexts:  9
 * YES:                47  (97.9%)
 * NO:                 1   (2.1%)
 * Attested success:   95.7%
 * ```
 *
 * A table because it is one: the beat is about comparing decision groups, and the evidence
 * per group is the same five columns every time. The per-group detail — gates, suggested
 * action, counterexamples — is beat 5's, and lives in `RecommendationCard`.
 *
 * "Attested success", never "measured": the caller asserted the outcome and LenGentic has no
 * independent way to verify it (`CLAUDE.md` ## Product claims). The column header carries the
 * word so the qualifier travels with the number rather than sitting in a footnote.
 */
export function DecisionHistoryCard({
  recommendations,
}: {
  recommendations: readonly Recommendation[];
}) {
  return (
    <section className="card">
      <h2 className="card-title">Decision History</h2>

      {recommendations.length === 0 ? (
        <p className="note-inline">
          No decision group has produced a recommendation yet. Run <strong>Analyze</strong> above;
          if every group is suppressed, the analysis result names which gate refused it.
        </p>
      ) : (
        <table className="decision-history">
          <thead>
            <tr>
              <th scope="col">Decision</th>
              <th scope="col">Workflow</th>
              <th scope="col">Samples</th>
              <th scope="col">Distinct contexts</th>
              <th scope="col">Distribution</th>
              <th scope="col">Attested success</th>
              <th scope="col">Outcome coverage</th>
            </tr>
          </thead>
          <tbody>
            {recommendations.map((recommendation) => (
              <DecisionHistoryRow key={recommendation.id} recommendation={recommendation} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function DecisionHistoryRow({ recommendation }: { recommendation: Recommendation }) {
  const { evidence, groupKey } = recommendation;

  return (
    <tr>
      <th scope="row">
        <code>{groupKey.decisionType}</code>
      </th>
      <td>{workflowLabel(groupKey)}</td>
      <td className="numeric">{String(evidence.sampleCount)}</td>
      <td className="numeric">{String(evidence.distinctContextKeyCount)}</td>
      <td>
        <Distribution options={evidence.optionDistribution} />
      </td>
      {/* N/A, never 0.0% — nothing attested is not the same claim as everything failed. */}
      <td className="numeric">
        {percentOrNotAttested(evidence.dominantOptionAttestedSuccessRate)}
      </td>
      <td className="numeric">{percent(evidence.outcomeCoverage)}</td>
    </tr>
  );
}

/**
 * `YES 47 (97.9%) | NO 1 (2.1%)`, in the order the engine reported. Not re-sorted: the
 * dominant option is named explicitly on the recommendation below, so re-ordering here would
 * only make the two views disagree about what the engine actually returned.
 */
function Distribution({ options }: { options: readonly OptionCount[] }) {
  if (options.length === 0) return <span className="note-absent">no observations</span>;

  return (
    <ul className="distribution">
      {options.map((option) => (
        <li key={option.option}>
          <code>{option.option}</code> {String(option.count)} ({percent(option.share)})
        </li>
      ))}
    </ul>
  );
}
