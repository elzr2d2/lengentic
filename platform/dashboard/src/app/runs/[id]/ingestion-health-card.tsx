import type { RunDetailView } from '@lengentic/shared/read';
import {
  assessIngestionHealth,
  formatByteCount,
  formatCount,
  type CollectionReport,
} from '@/lib/run-telemetry';

/**
 * The Run Explorer's **Ingestion Health** view — `MVP_PLAN_V3.md:1789`, "dropped events, if
 * any".
 *
 * ## What this card is allowed to claim
 *
 * The DoD sentence this card serves is "whether any telemetry was lost or truncated". Every
 * row below is therefore one of two things: a measurement the response actually carried, or
 * the words `not reported`. There is no third rendering, and in particular there is no `0`
 * standing in for a question nobody answered — `CLAUDE.md` ## Product claims, and the same
 * reasoning `run-summary.ts` uses when it refuses to report `droppedTelemetryEventCount` as
 * anything but `null`.
 *
 * ## The dropped-event count, and why it says nothing
 *
 * §16's drop counters (`droppedOverflow`, `droppedInvalid`, `droppedTooLarge`,
 * `droppedAfterShutdown`, `droppedUndeliverable`) are **client-side SDK state**. No envelope
 * field, no `IngestResponse` field and no column carries them to the platform, so
 * `GET /v1/runs/:id` — the only endpoint this page reads — has nothing to report, and
 * `GET /v1/runs/:id/summary` answers `null` for the same reason.
 *
 * The row is on the card anyway, saying `not reported`, with the reason beside it. A reader
 * who cannot see the row concludes the Dashboard does not track drops; a reader who sees a `0`
 * concludes none were dropped. Only the third rendering is true.
 *
 * ## What this card is NOT
 *
 * Not a count of the Errors above. Those are the *instrumented system's* failures, reported as
 * telemetry and stored as rows; a rejected event never becomes a row at all. Counting the
 * agent's errors as ingestion faults would report the platform's health from the agent's, which
 * `run-view.ts` names as the mistake this vocabulary exists to prevent.
 */
const DROP_COUNT_NOTE =
  '§16’s drop counters are client-side SDK state. No envelope field, no ingest response and no column carries them to the platform, so no drop count has been reported for this run. That is not a claim that none were dropped.';

export function IngestionHealthCard({ run }: { run: RunDetailView }) {
  const health = assessIngestionHealth(run);

  return (
    <section className="card">
      <h2 className="card-title">Ingestion health</h2>

      <p className="note-inline">
        Which of the Phase 4 collections this response answered, and what the stored telemetry lost
        on the way here. A measure whose collection was never carried reads <em>not reported</em> —
        never zero.
      </p>

      {health.collections.map((collection) => (
        <CollectionRow key={collection.label} collection={collection} />
      ))}

      <HealthRow label="Tool inputs truncated" value={formatCount(health.toolInputsTruncated)} />
      <HealthRow label="Tool outputs truncated" value={formatCount(health.toolOutputsTruncated)} />
      <HealthRow
        label="Payload bytes lost to truncation"
        value={formatByteCount(health.truncatedOriginalBytes)}
      />
      <HealthRow
        label="Tool calls with a self-contradicting clock"
        value={formatCount(health.toolCallsWithClockAnomaly)}
      />
      <HealthRow
        label="Model calls missing an input token count"
        value={formatCount(health.modelCallsMissingInputTokens)}
      />
      <HealthRow
        label="Model calls missing an output token count"
        value={formatCount(health.modelCallsMissingOutputTokens)}
      />
      {/* Hardcoded, and deliberately not routed through `assessIngestionHealth`: there is no
          input for it to read. A function returning an unconditional `null` would look like a
          computation and would be the first thing a future reader trusted. */}
      <HealthRow label="Dropped telemetry events" value="not reported" />

      <p className="note-inline note-absent">{DROP_COUNT_NOTE}</p>
    </section>
  );
}

/**
 * One collection's line: how many rows, or that the response never answered the question.
 *
 * `'not answered by this response'` rather than `'not reported'`, because these two facts have
 * different remedies — a count nobody measured versus a field the deployed API did not send.
 */
function CollectionRow({ collection }: { collection: CollectionReport }) {
  return (
    <HealthRow
      label={collection.label}
      value={
        collection.presence === 'absent'
          ? 'not answered by this response'
          : String(collection.count)
      }
    />
  );
}

function HealthRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="value">{value}</span>
    </div>
  );
}
