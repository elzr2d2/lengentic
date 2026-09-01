import type { DecisionView, RunDetailView } from '@lengentic/shared/read';
import { readRunTelemetry } from '@/lib/run-telemetry';
import {
  Absence,
  IdField,
  InstantField,
  Mark,
  MetaRow,
  Tag,
  TextField,
  UnsizedPayload,
  type TagTone,
} from './telemetry-parts';

/**
 * The Run Explorer's **Decisions** view — `MVP_PLAN_V3.md:1785`: "contextKey visible; strategy
 * evidence per §29".
 *
 * ## The two things the plan names, and why each is a requirement rather than a nicety
 *
 * **`contextKey` visible.** §14 makes it the caller's obligation, and a null one means the
 * decision "is stored but **excluded from aggregation**". `run-view.ts` states the consequence
 * for exactly this card: "a reader who cannot see the null cannot tell a decision that will
 * never be grouped from one that will". So a missing key is a mark, not a blank cell — the
 * decision is on the page, and so is the fact that no analyzer will ever see it.
 *
 * **Strategy evidence per §29.** `MVP_PLAN_V3.md:641` — the Playground's sequential-vs-parallel
 * choice "uses this entity unchanged", with `rawContext` carrying "the awarenessContext object".
 * There is no strategy-specific rendering below and there must not be one: the evidence is
 * `rawContext` on an ordinary Decision, and a card that special-cased `execution_strategy` would
 * be a second definition of a thing the plan deliberately refused to make special.
 *
 * ## Attested, never measured
 *
 * `CLAUDE.md` ## Product claims. `outcome` arrived because a caller asserted it — §14 makes
 * attestation "an independent, idempotent telemetry event" — and the platform has no way to
 * check it. The card labels the field `Outcome attested by` and names the attester, which is
 * also why `OUTCOME_ATTESTED_BY` has an `UNKNOWN` member at all.
 */
export function DecisionsCard({ run }: { run: RunDetailView }) {
  const { decisions } = readRunTelemetry(run);

  return (
    <section className="card">
      <h2 className="card-title">Decisions</h2>

      <p className="note-inline">
        Outcomes are <em>attested</em> by the caller, never measured here — LenGentic records what
        it was told. A decision with no <code>contextKey</code> is stored and excluded from
        aggregation (&sect;14).
      </p>

      <Absence presence={decisions.presence} plural="decisions" />

      {decisions.presence === 'some' ? (
        <ul className="telemetry-list">
          {decisions.rows.map((decision) => (
            <DecisionRow key={decision.id} decision={decision} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function DecisionRow({ decision }: { decision: DecisionView }) {
  return (
    <li className="telemetry-row">
      <div className="telemetry-head">
        <span className="telemetry-name">
          {decision.decisionType ?? '(no decision.recorded event — attestation only)'}
        </span>
        {decision.contextKey === null ? (
          <Mark tone="excluded">no contextKey &middot; stored, excluded from aggregation</Mark>
        ) : null}
        {/* §14: an attestation may arrive for a `decisionId` nothing recorded, and "is accepted
            and stored, not rejected". Such a row has no decisionType, no options and no
            selection — five blanks that read as a rendering fault unless the card says why. */}
        {decision.decisionType === null ? (
          <Mark tone="attestation-only">attested for an id nothing recorded</Mark>
        ) : null}
        <Tag tone={outcomeTone(decision.outcome)}>{decision.outcome}</Tag>
      </div>

      <div className="telemetry-fields">
        <TextField
          label="contextKey"
          value={decision.contextKey ?? 'none — excluded from aggregation'}
        />
        <TextField label="contextKeyVersion" value={decision.contextKeyVersion} />
        {/* An empty array and a null are different answers: the caller offered no options, or
            never told us what was on the table. `run-view.ts` keeps the column nullable for
            the attestation-first case specifically. */}
        <TextField label="Options" value={describeOptions(decision.availableOptions)} />
        <TextField label="Selected" value={decision.selectedOption} />
        <TextField label="Outcome attested by" value={decision.outcomeAttestedBy} />
        <InstantField label="Outcome observed" iso={decision.outcomeObservedAt} />
        <IdField label="Step" id={decision.stepId} />
      </div>

      <UnsizedPayload
        label="rawContext — the evidence this decision was taken on (§29)"
        value={decision.rawContext}
      />

      <MetaRow id={decision.id}>
        <time className="value" dateTime={decision.createdAt}>
          {decision.createdAt}
        </time>
      </MetaRow>
    </li>
  );
}

/** Null is "we were never told"; `[]` is "the caller offered nothing". Not the same sentence. */
function describeOptions(options: readonly string[] | null): string | null {
  if (options === null) return null;
  if (options.length === 0) return '(the caller recorded no options)';

  return options.join(', ');
}

function outcomeTone(outcome: DecisionView['outcome']): TagTone {
  switch (outcome) {
    case 'SUCCESS':
      return 'ok';
    case 'FAILURE':
      return 'down';
    case 'UNKNOWN':
      return 'muted';
  }
}
