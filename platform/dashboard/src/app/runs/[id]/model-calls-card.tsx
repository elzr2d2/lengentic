import type { ModelCallView, RunDetailView } from '@lengentic/shared/read';
import { formatCount, readRunTelemetry } from '@/lib/run-telemetry';
import {
  Absence,
  Field,
  IdField,
  InstantField,
  Mark,
  MetaRow,
  Tag,
  TextField,
} from './telemetry-parts';

/**
 * The Run Explorer's **Model Calls** view — `MVP_PLAN_V3.md:1788`.
 *
 * ## The one rule this card exists to keep
 *
 * §13 marks exactly two of a ModelCall's fields optional — `inputTokens` and `outputTokens` —
 * and `run-view.ts` says why they stay `null` instead of becoming `0`: a zero "would read as
 * 'this call used no tokens' — a measurement the platform never received". A provider that
 * reported no usage is an ordinary, expected case, not a call that was free.
 *
 * So a missing count renders as the words `not reported`, and the row carries a mark naming
 * *which* count is missing. `formatCount` is the same function the Ingestion Health card uses
 * for the same reason, so the two cards cannot drift into disagreeing about what a null means.
 *
 * ## No totals
 *
 * There is no token sum and no latency sum on this card. §23's roll-up is
 * `platform/api/src/runs/run-summary.ts`, served from `GET /v1/runs/:id/summary`, and it
 * already carries `modelCallsMissingInputTokens` precisely so its totals are readable as
 * totals rather than as floors. A second implementation here would be free to disagree with
 * the one the product ships, and a reader would have no way to tell which was right.
 */
export function ModelCallsCard({ run }: { run: RunDetailView }) {
  const { modelCalls } = readRunTelemetry(run);

  return (
    <section className="card">
      <h2 className="card-title">Model calls</h2>

      <p className="note-inline">
        Latency is the caller&rsquo;s own measurement per call. A token count the provider did not
        report stays unreported — it is never read as zero usage (&sect;13).
      </p>

      <Absence presence={modelCalls.presence} plural="model calls" />

      {modelCalls.presence === 'some' ? (
        <ul className="telemetry-list">
          {modelCalls.rows.map((call) => (
            <ModelCallRow key={call.id} call={call} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ModelCallRow({ call }: { call: ModelCallView }) {
  const missing = describeMissingTokens(call);

  return (
    <li className="telemetry-row">
      <div className="telemetry-head">
        <span className="telemetry-name">{`${call.provider} / ${call.model}`}</span>
        {missing === null ? null : <Mark tone="unreported">{missing}</Mark>}
        <Tag tone="muted">{`${String(call.latencyMs)}ms`}</Tag>
      </div>

      <div className="telemetry-fields">
        <Field label="Input tokens">
          <span className="value">{formatCount(call.inputTokens)}</span>
        </Field>
        <Field label="Output tokens">
          <span className="value">{formatCount(call.outputTokens)}</span>
        </Field>
        {/* A free string, matching the wire and the column. `run-view.ts`: an enum invented on
            the read side "would reject values ingestion already accepted". */}
        <TextField label="Status" value={call.status} />
        <IdField label="Step" id={call.stepId} />
        <InstantField label="Recorded" iso={call.createdAt} />
      </div>

      <MetaRow id={call.id} />
    </li>
  );
}

/**
 * Which token count the provider did not report, named precisely.
 *
 * Three sentences rather than one, because "no token usage reported" over a call that reported
 * its input tokens and not its output would be false about the half that arrived.
 */
function describeMissingTokens(call: ModelCallView): string | null {
  const noInput = call.inputTokens === null;
  const noOutput = call.outputTokens === null;

  if (noInput && noOutput) return 'no token usage reported';
  if (noInput) return 'no input token count reported';
  if (noOutput) return 'no output token count reported';

  return null;
}
