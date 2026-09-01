import type { ErrorView, RunDetailView } from '@lengentic/shared/read';
import { readRunTelemetry } from '@/lib/run-telemetry';
import {
  Absence,
  IdField,
  InstantField,
  MetaRow,
  TextField,
  UnsizedPayload,
} from './telemetry-parts';

/**
 * The Run Explorer's **Errors** view — `MVP_PLAN_V3.md:1788`.
 *
 * ## Whose failures these are
 *
 * `run-view.ts`, on `ErrorViewSchema`: these are errors "the *instrumented system* reported as
 * telemetry, not an ingestion rejection — rejections are `INGEST_ERROR_CODES` on the ingest
 * response and never become rows. A consumer that showed these under a heading like 'ingestion
 * errors' would be reporting the platform's health from the agent's failures."
 *
 * That is the trap this card is shaped to avoid, and it is a live one here: the very next card
 * on the page is Ingestion Health. Two adjacent sections, one counting the agent's failures and
 * one counting the platform's, and only a sentence keeps them apart — so the sentence is on the
 * card rather than in this comment, where a reader will actually meet it.
 */
const PROVENANCE_NOTE =
  'Reported by the instrumented system as telemetry. These are the agent’s own failures, not ingestion rejections — a rejected event never becomes a row.';

export function ErrorsCard({ run }: { run: RunDetailView }) {
  const { errors } = readRunTelemetry(run);

  return (
    <section className="card">
      <h2 className="card-title">Errors</h2>

      <p className="note-inline">{PROVENANCE_NOTE}</p>

      <Absence presence={errors.presence} plural="errors" />

      {errors.presence === 'some' ? (
        <ul className="telemetry-list">
          {errors.rows.map((error) => (
            <ErrorRow key={error.id} error={error} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ErrorRow({ error }: { error: ErrorView }) {
  return (
    <li className="telemetry-row">
      <div className="telemetry-head">
        <span className="telemetry-name">{error.type}</span>
      </div>

      <div className="telemetry-fields">
        <TextField label="Message" value={error.message} />
        <IdField label="Step" id={error.stepId} />
        <InstantField label="Recorded" iso={error.createdAt} />
      </div>

      <UnsizedPayload label="metadata" value={error.metadata} />

      <MetaRow id={error.id} />
    </li>
  );
}
