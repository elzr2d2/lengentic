import type { RunDetailView } from '@lengentic/shared/read';
import {
  buildRunTimeline,
  countTimelineSteps,
  describeTimelineAnomalies,
  formatDuration,
  type TimelineEntry,
  type TimelineShape,
  type UnplacedStep,
} from '@/lib/timeline';

/**
 * The Run Explorer's **Execution Timeline** — `MVP_PLAN_V3.md:1783`, "client clocks ONLY".
 *
 * All the arithmetic is in `@/lib/timeline`, which never reads a server clock; this file is
 * the rendering, plus the two things a reader needs in order to trust the picture:
 *
 * 1. The axis says which clock it is drawn on, in the card, not in a doc comment. A bar chart
 *    of durations is exactly the kind of artefact that gets screenshotted into an incident
 *    review, and "is this network time or agent time" is the first question it has to answer.
 * 2. Every step in the response is accounted for — placed, or listed with the reason it could
 *    not be. Same alarm as the Steps card, for the same reason: a timeline that silently drops
 *    the steps it cannot position looks identical to a run that had fewer steps.
 */
export function TimelineCard({ run }: { run: RunDetailView }) {
  const timeline = buildRunTimeline(run);
  const accounted = countTimelineSteps(timeline);

  if (run.steps.length === 0) {
    return (
      <section className="card">
        <h2 className="card-title">Execution timeline</h2>
        <p className="note-inline">
          No steps have been recorded against this run, so there is nothing to place on an axis.
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2 className="card-title">Execution timeline{describeTimelineAnomalies(timeline)}</h2>

      {/* §12: `occurredAt` is client time and is "authoritative for ordering and duration";
          `receivedAt` and `lastEventAt` are the server's and appear nowhere on this axis.
          MVP_PLAN_V3.md:493 — "Never combine client and server clocks in one duration
          calculation." The Steps card above orders by arrival; this one orders by execution,
          and the two disagreeing is a real observation about the batch, not a defect. */}
      <p className="note-inline">
        Client clocks only. Ordered by the caller&rsquo;s <code>occurredAt</code>, not by arrival —
        the Steps card shows arrival order.
      </p>

      {accounted === run.steps.length ? null : (
        <p className="note-inline note-alarm">
          {String(run.steps.length - accounted)} step(s) in the response are on neither the axis nor
          the unplaced list. That is a Dashboard defect, not a property of the run.
        </p>
      )}

      <div className="row">
        <span className="row-label">Run duration</span>
        <span className="value">{formatDuration(timeline.runDurationMs)}</span>
      </div>
      <div className="row">
        <span className="row-label">Window</span>
        <span className="value">
          {timeline.window === null
            ? '—'
            : `${timeline.window.startedAt} → ${timeline.window.endsAt}`}
        </span>
      </div>

      <ul className="timeline">
        {timeline.entries.map((entry) => (
          <TimelineRow key={entry.step.id} entry={entry} />
        ))}
      </ul>

      {timeline.unplaced.length > 0 ? <UnplacedList unplaced={timeline.unplaced} /> : null}
    </section>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  return (
    <li className="timeline-row">
      <div className="timeline-head">
        <span className="timeline-name">{entry.step.name ?? '(no step.started event yet)'}</span>
        <ShapeMark shape={entry.shape} />
        <span className="timeline-duration">{formatDuration(entry.durationMs)}</span>
      </div>
      <TimelineTrack entry={entry} />
      <div className="timeline-meta">
        <code>{entry.step.id}</code>
        <Instant iso={entry.startedAt} />
        <Instant iso={entry.completedAt} />
      </div>
    </li>
  );
}

/**
 * The bar.
 *
 * A `null` position means the window had no width — every client instant in the run is the
 * same one — and then there is no fraction to draw. The track renders empty rather than
 * defaulting to `0%`, which would be a chart asserting an ordering the data does not contain.
 *
 * A zero-width bar becomes a point marker rather than an invisible element: `end-only` and
 * `reversed` steps have no observed interval, and a bar that renders as nothing is
 * indistinguishable from a row the page failed to draw.
 */
function TimelineTrack({ entry }: { entry: TimelineEntry }) {
  if (entry.offsetPercent === null || entry.widthPercent === null) {
    return (
      <div className="timeline-track">
        <span className="timeline-unscaled">no axis — every instant in this run is the same</span>
      </div>
    );
  }

  return (
    <div className="timeline-track">
      <div
        className={`timeline-bar timeline-bar-${entry.shape}${
          entry.widthPercent === 0 ? ' timeline-bar-point' : ''
        }`}
        style={{ left: percent(entry.offsetPercent), width: percent(entry.widthPercent) }}
      />
    </div>
  );
}

/**
 * Why this bar looks the way it does.
 *
 * `closed` carries no mark — a start, an end and a duration is the ordinary case and the
 * duration column already says it. The other three are marked because each is a bar a reader
 * would otherwise read as a measurement: an `open` bar's right edge is the window's, not the
 * step's; `end-only` and `reversed` are markers with no observed interval at all.
 */
function ShapeMark({ shape }: { shape: TimelineShape }) {
  switch (shape) {
    case 'closed':
      return null;
    case 'open':
      return <span className="placement placement-open">running · no completion yet</span>;
    case 'end-only':
      return (
        <span className="placement placement-end-only">
          completed before any start · duration unknown
        </span>
      );
    case 'reversed':
      return (
        <span className="placement placement-cycle">
          reversed client clock · completion precedes start
        </span>
      );
  }
}

/**
 * The steps that carry no client instant at all.
 *
 * Listed rather than dropped: §12 lets any event create a row, so a step known only from an
 * event that carried neither a start nor a completion is a real, expected shape. It cannot go
 * on a client-clock axis without inventing a position for it, and it must not vanish.
 */
function UnplacedList({ unplaced }: { unplaced: readonly UnplacedStep[] }) {
  return (
    <>
      <p className="note-inline">
        {String(unplaced.length)} step(s) carry no client clock and cannot be placed on this axis.
        They are not missing from the run.
      </p>
      <ul className="timeline timeline-unplaced">
        {unplaced.map(({ step }) => (
          <li key={step.id} className="timeline-row">
            <div className="timeline-head">
              <span className="timeline-name">{step.name ?? '(no step.started event yet)'}</span>
              <span className="placement placement-unplaced">no client clock</span>
            </div>
            <div className="timeline-meta">
              <code>{step.id}</code>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function Instant({ iso }: { iso: string | null }) {
  if (iso === null) return <span className="value">—</span>;

  return (
    <time className="value" dateTime={iso}>
      {iso}
    </time>
  );
}

/**
 * A CSS length from a raw fraction.
 *
 * Rounded to four decimals so the markup carries `33.3333%` instead of seventeen digits of
 * float noise, which no browser can render and no test can read. The rounding is presentation
 * only — `TimelineEntry` keeps the exact value, so nothing downstream inherits the loss.
 */
function percent(value: number): string {
  return `${String(Math.round(value * 10000) / 10000)}%`;
}
