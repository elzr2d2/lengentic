import type { AnalysisRunResponse, EvaluatedGroup } from '@lengentic/shared';
import { FailedGateList, GateTable } from './gate-table';
import { percentOrNotAttested, workflowLabel } from './format';

/**
 * §22's analysis response, and §25's **closing move**.
 *
 * ```text
 * Verdict: SUPPRESSED
 * Gates:   G2 context_diversity  (2 < 5)
 * ```
 *
 * §22 is explicit that the response carries **every** group the engine looked at, not only
 * the ones that produced a recommendation: a SUPPRESSED group carries `recommendationId:
 * null`, is returned here, and is never persisted — there is no suppression table and no
 * suppression history in the MVP. So this card is the only place a refusal is ever visible,
 * and it renders the SUPPRESSED groups **first**: "a tool that produces recommendations is
 * unremarkable. A tool that demonstrably declines to produce bad ones is the thing worth
 * showing."
 *
 * Every failing gate is named, not the first (§19's reporting rule). `failedGates` comes off
 * the wire already refined against `gates` on every parse, so this component names what it was
 * given rather than re-deriving a rule the contract already enforces.
 */
export function AnalysisResultCard({ response }: { response: AnalysisRunResponse }) {
  const suppressed = response.evaluatedGroups.filter((group) => group.verdict === 'SUPPRESSED');
  const candidates = response.evaluatedGroups.filter((group) => group.verdict === 'CANDIDATE');

  return (
    <section className="card">
      <h2 className="card-title">
        Analysis result &middot; {String(response.evaluatedGroups.length)} group
        {response.evaluatedGroups.length === 1 ? '' : 's'} evaluated
      </h2>

      <p className="note-inline">
        Every group the analyzer looked at, emitted or not. A suppressed group is reported here and
        never stored &mdash; the refusal is part of the answer, not the absence of one.
      </p>

      <div className="row">
        <span className="row-label">Candidates</span>
        <span className="value">{String(candidates.length)}</span>
      </div>
      <div className="row">
        <span className="row-label">Suppressed</span>
        <span className="value">{String(suppressed.length)}</span>
      </div>

      {response.evaluatedGroups.length === 0 ? (
        <p className="note-inline">
          The analyzer found no decision group to evaluate. Send some runs through the telemetry
          SDK, attest their outcomes, and analyze again.
        </p>
      ) : (
        <ul className="group-list">
          {[...suppressed, ...candidates].map((group) => (
            <EvaluatedGroupRow key={groupId(group)} group={group} />
          ))}
        </ul>
      )}
    </section>
  );
}

function EvaluatedGroupRow({ group }: { group: EvaluatedGroup }) {
  const suppressed = group.verdict === 'SUPPRESSED';

  return (
    <li className="group-row">
      <div className="group-head">
        <span className="group-name">
          <code>{group.groupKey.decisionType}</code>
        </span>
        <span className={`status ${suppressed ? 'status-warn' : 'status-ok'}`}>
          {group.verdict}
        </span>
      </div>

      <div className="row">
        <span className="row-label">Workflow</span>
        <span className="value">{workflowLabel(group.groupKey)}</span>
      </div>

      {/*
        `N/A`, never `0.0%`, and this row is the only place on the product where a reader can
        actually see it: a null rate forces G4 NOT_APPLICABLE, which caps outcome coverage
        below G5's threshold, which suppresses the group — and a suppressed group has no
        persisted row for the recommendation card to render from. "We were told nothing" and
        "we were told it always failed" send a reader to opposite conclusions, so the refusal
        has to be legible on the refusal itself.
      */}
      <div className="row">
        <span className="row-label">Attested success (dominant option)</span>
        <span className="value">
          {percentOrNotAttested(group.dominantOptionAttestedSuccessRate)}
        </span>
      </div>

      {suppressed ? (
        <div className="row">
          <span className="row-label">Failed gates</span>
          <FailedGateList failedGates={group.failedGates} />
        </div>
      ) : (
        <div className="row">
          <span className="row-label">Recommendation</span>
          {/* Null on a SUPPRESSED group by contract, so this branch is the only one that can
              name a row — and a CANDIDATE always has one. */}
          <code>{group.recommendationId}</code>
        </div>
      )}

      <GateTable gates={group.gates} />
    </li>
  );
}

/**
 * The group key, joined — the identity §18 gives a group, and the only stable key here.
 * `recommendationId` is null for exactly the rows this card exists to show.
 *
 * The separator is written as the ESCAPE sequence `\u0000`, never as a literal NUL byte in
 * the source. The value is identical at runtime; the difference is that git classifies a
 * file containing a raw NUL as binary, which took this file out of every `git diff` —
 * including the 5b wave gate's, whose entire job was reading the combined diff.
 *
 * NUL itself is kept as the separator because no stored group-key member can contain one:
 * Postgres rejects U+0000 in a text or jsonb value at the wire level, and
 * `telemetry.integration.spec.ts`'s F2 case proves that is a per-event REJECTED at ingest.
 * Two distinct group keys therefore cannot serialize to one React key. `serializeGroupKey`
 * in `platform/analysis-engine` joins the same four members with a plain SPACE and does not
 * have that property; `BACKLOG.md` carries it.
 */
function groupId(group: EvaluatedGroup): string {
  const { workflowName, workflowVersion, decisionType, contextKeyVersion } = group.groupKey;

  return [workflowName, workflowVersion, decisionType, contextKeyVersion].join('\u0000');
}
