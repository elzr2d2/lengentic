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
 * ## The dropped-event count
 *
 * §16's five drop counters (`droppedOverflow`, `droppedInvalid`, `droppedTooLarge`,
 * `droppedAfterShutdown`, `droppedUndeliverable`) are still client-side SDK state — no
 * envelope field carries the breakdown, and `GET /v1/runs/:id` (`run.tsx`'s own detail
 * fetch) still has nothing to report. ADR 0014 decision 2 added exactly one number: the
 * batch-level `droppedSinceLastBatch` SUM, folded into `Run.droppedTelemetryEventCount` and
 * surfaced at `GET /v1/runs/:id/summary` — a second, independent fetch
 * (`lib/runs-api.ts`'s `fetchRunDroppedTelemetryEventCount`), because the detail response
 * this page otherwise reads does not carry it.
 *
 * `droppedTelemetryEventCount` is `null` in exactly two cases this card cannot and need not
 * tell apart: no batch for this run has ever reported one, or the summary request itself
 * could not be answered. Either way the honest rendering is the same — `not reported`, with
 * the reason beside it — never a `0` standing in for a question nobody answered. A reader
 * who cannot see the row concludes the Dashboard does not track drops; a reader who sees a
 * `0` concludes none were dropped. Only the third rendering is true, and it is now also true
 * for a real reported zero: `0` prints as `0`, not as `not reported`.
 *
 * ## What this card is NOT
 *
 * Not a count of the Errors above. Those are the *instrumented system's* failures, reported as
 * telemetry and stored as rows; a rejected event never becomes a row at all. Counting the
 * agent's errors as ingestion faults would report the platform's health from the agent's, which
 * `run-view.ts` names as the mistake this vocabulary exists to prevent.
 */
/**
 * R2 (Reviewer finding, 2026-09-02): the previous wording — "no envelope field, no ingest
 * response and no column carries them to the platform" — was made false by the very commit
 * that shipped this card. ADR 0014 decision 2 added `IngestRequestSchema.droppedSinceLastBatch`
 * and the `Run.droppedTelemetryEventCount` column, so a wire field and a column now both
 * exist. Because no SDK produces the field yet, this is also the only branch a reader
 * currently sees, which made it the single most-read false sentence on the page.
 *
 * What is still true is the part that matters, and it is what this now says: §16's five
 * per-reason counters remain client-side SDK state (only their SUM crosses the wire), no drop
 * count has been reported for THIS run, and absence is not a claim that nothing was dropped.
 * The two reasons are named together deliberately — `lib/runs-api.ts`'s
 * `fetchRunDroppedTelemetryEventCount` collapses a failed `/summary` fetch into the same
 * `null`, so a note that claimed only "never reported" would be false after a transport
 * error.
 *
 * S7 (Reviewer, Phase 4 phase gate repair attempt 1): exported, not module-private — the
 * exact wording used to be duplicated verbatim in `runs-pages.spec.ts` (twice), which failed
 * on any wording change to this string alone, R2 among them. The test now imports this
 * constant and asserts on it, pinning *which* note renders rather than *how* it is spelled.
 */
export const DROP_COUNT_NOTE =
  '§16’s five per-reason drop counters stay client-side SDK state; only their sum crosses the wire, and none has been reported for this run — either no batch has sent one, or the run summary could not be fetched. That is not a claim that none were dropped.';

export function IngestionHealthCard({
  run,
  droppedTelemetryEventCount,
}: {
  run: RunDetailView;
  /**
   * `GET /v1/runs/:id/summary`'s `droppedTelemetryEventCount` — `null` when no batch has
   * ever reported one for this run, OR when that request could not be answered at all. Both
   * render the same way: `not reported`.
   */
  droppedTelemetryEventCount: number | null;
}) {
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
      {/* ADR 0014 decision 2: the one row on this card whose input is NOT `run`
          (`RunDetailView`) — it comes from the separate `/summary` fetch `page.tsx` makes,
          because `GET /v1/runs/:id` never carries this field at all. `formatCount` already
          gives `null` the same `not reported` rendering every other absent measure on this
          card gets, thousands separators included for a real value. */}
      <HealthRow label="Dropped telemetry events" value={formatCount(droppedTelemetryEventCount)} />

      {droppedTelemetryEventCount === null ? (
        <p className="note-inline note-absent">{DROP_COUNT_NOTE}</p>
      ) : null}
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
