import type { RunDetailView, StepView } from '@lengentic/shared/read';

/**
 * The Execution Timeline of one Run — **client clocks ONLY** (`MVP_PLAN_V3.md:1783`).
 *
 * ## Why this is a module and not a few lines of JSX
 *
 * `MVP_PLAN_V3.md:493` states the rule this file exists to keep: *"Never combine client and
 * server clocks in one duration calculation."* `RunDetailView` carries both, side by side, on
 * every object it returns — `startedAt`/`completedAt` are the caller's clock (§12: "occurredAt
 * Client time. Authoritative for ordering and duration"), while `receivedAt` and `lastEventAt`
 * are the server's. Nothing in the type system distinguishes them; they are all
 * `TimestampSchema`. A timeline assembled inline would be one autocomplete away from an axis
 * that measures network latency and calls it agent latency, and the resulting bar chart would
 * look entirely plausible.
 *
 * So the arithmetic is here, where it can be proven in a node environment, and the rule is
 * mechanical: **this file reads `startedAt` and `completedAt` and nothing else.** The
 * `receivedAt` fields are not referenced anywhere below, and `timeline.spec.ts` holds a
 * fixture whose server clocks are hours away from its client clocks — so an axis that reached
 * for the wrong field would move.
 *
 * ## Totality, for the same reason `step-tree.ts` has it
 *
 * §12 permits a completion event to arrive for an entity that never had a start
 * ("A completion event for an unseen entityId creates the row in a completed state"), so a
 * `StepView` with `startedAt === null` is an ordinary, expected shape — not a defect. A
 * timeline that quietly dropped those rows would render four of seven steps and look exactly
 * like a run that had four. Every input step therefore leaves this function exactly once,
 * either as a placed {@link TimelineEntry} or in {@link RunTimeline.unplaced} with the reason
 * it could not be placed, and the page states the count out loud.
 */

/**
 * What the client clock says about one step's interval.
 *
 * Four shapes rather than "has a duration / does not", because the three degenerate ones mean
 * different things to a reader and only one of them is a fault:
 *
 * - `closed` — start and end both present and ordered. The only shape with a duration.
 * - `open` — started, no completion yet. Its bar runs to the end of the window and is marked;
 *   drawing it zero-width would show a long-running step as an instant.
 * - `end-only` — §12's completion-before-start. Placed at its completion instant, with no
 *   duration to report: the system never observed when it began.
 * - `reversed` — both present, and the end precedes the start. The caller's clock moved
 *   backwards (or two processes with different clocks wrote the two events). Reported as an
 *   anomaly and given no duration, rather than clamped to zero — a clamped bar asserts an
 *   instantaneous step, which is a claim about the run nobody made.
 */
export type TimelineShape = 'closed' | 'open' | 'end-only' | 'reversed';

/** Why a step is not on the axis. One case: it carries no client instant at all. */
export type UnplacedReason = 'no-client-clock';

export interface TimelineWindow {
  /** Epoch ms of the earliest client instant in the run, including the Run's own. */
  readonly startMs: number;
  readonly endMs: number;
  /** `endMs - startMs`. Zero when every client instant in the run is the same one. */
  readonly spanMs: number;
  readonly startedAt: string;
  readonly endsAt: string;
}

export interface TimelineEntry {
  readonly step: StepView;
  readonly shape: TimelineShape;
  /** The client instants, repeated here so a row can be read without re-consulting the step. */
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** `completedAt - startedAt`, client clocks only. Null for every shape but `closed`. */
  readonly durationMs: number | null;
  /**
   * Where the bar sits in the window, 0–100. Null when the window has no width — every
   * client instant in the run is identical, so there is no axis to be a fraction of, and
   * emitting `0` there would draw a chart that reads as real.
   */
  readonly offsetPercent: number | null;
  readonly widthPercent: number | null;
}

export interface UnplacedStep {
  readonly step: StepView;
  readonly reason: UnplacedReason;
}

export interface RunTimeline {
  /** Null when the run carries no client instant at all — not even its own `startedAt`. */
  readonly window: TimelineWindow | null;
  readonly entries: readonly TimelineEntry[];
  readonly unplaced: readonly UnplacedStep[];
  /**
   * The Run's own client-clock duration, or null while it is still running.
   *
   * Deliberately NOT `window.spanMs`: the window is stretched by whatever the steps reported,
   * and a step whose client clock overshoots its run's completion would otherwise inflate the
   * run's stated duration. This is `run.completedAt - run.startedAt` and nothing else.
   */
  readonly runDurationMs: number | null;
}

/**
 * Ordered by client clock — `occurredAt` is "authoritative for ordering" (§12) — with ties
 * broken on `step.id`.
 *
 * Not the server's `receivedAt asc, id asc` that `RunDetailView.steps` arrives in, and that
 * `buildStepTree` preserves. The two orders disagreeing is the interesting case, not a
 * problem to be smoothed over: it is what a batch delivered out of order looks like. The
 * hierarchy view shows arrival, this one shows execution, and each says which it is.
 *
 * The tie-break makes the order total and independent of the input array's order, so a run
 * whose steps all share one instant renders the same way on every reload. `id` is the tie-break
 * for the same reason ADR 0007 uses `eventId`: it is the only other value guaranteed present
 * and unique.
 */
export function buildRunTimeline(run: RunDetailView): RunTimeline {
  const window = computeWindow(run);
  const placeable: StepView[] = [];
  const unplaced: UnplacedStep[] = [];

  for (const step of run.steps) {
    if (anchorOf(step) === null) {
      unplaced.push({ step, reason: 'no-client-clock' });
      continue;
    }

    placeable.push(step);
  }

  const entries = placeable
    .slice()
    .sort(byClientClockThenId)
    .map((step) => place(step, window));

  return {
    window,
    entries,
    unplaced,
    runDurationMs: closedDuration(run.startedAt, run.completedAt),
  };
}

/**
 * The instant a step is positioned at: its start, or — for §12's completion-before-start —
 * its completion. Null only when the caller sent neither, which is what `unplaced` is for.
 */
function anchorOf(step: StepView): string | null {
  return step.startedAt ?? step.completedAt;
}

function byClientClockThenId(left: StepView, right: StepView): number {
  const leftMs = epochOf(anchorOf(left));
  const rightMs = epochOf(anchorOf(right));

  if (leftMs !== null && rightMs !== null && leftMs !== rightMs) return leftMs - rightMs;

  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * The window every bar is a fraction of: the earliest and latest **client** instant the run
 * carries, its own included.
 *
 * The Run's `startedAt`/`completedAt` are in the extent deliberately. A run whose first step
 * begins two seconds after the run itself started should show that gap — anchoring the axis
 * on the first step instead would silently move the origin and hide it.
 */
function computeWindow(run: RunDetailView): TimelineWindow | null {
  const instants: string[] = [];

  for (const iso of [run.startedAt, run.completedAt]) {
    if (iso !== null) instants.push(iso);
  }

  for (const step of run.steps) {
    for (const iso of [step.startedAt, step.completedAt]) {
      if (iso !== null) instants.push(iso);
    }
  }

  const epochs = instants.map(epochOf).filter((ms): ms is number => ms !== null);

  if (epochs.length === 0) return null;

  const startMs = Math.min(...epochs);
  const endMs = Math.max(...epochs);

  return {
    startMs,
    endMs,
    spanMs: endMs - startMs,
    startedAt: new Date(startMs).toISOString(),
    endsAt: new Date(endMs).toISOString(),
  };
}

function place(step: StepView, window: TimelineWindow | null): TimelineEntry {
  const shape = shapeOf(step);
  const anchorMs = epochOf(anchorOf(step));
  const endMs = boundedEndMs(step, shape, window);

  const positioned =
    window !== null && window.spanMs > 0 && anchorMs !== null && endMs !== null
      ? {
          offsetPercent: ((anchorMs - window.startMs) / window.spanMs) * 100,
          widthPercent: ((endMs - anchorMs) / window.spanMs) * 100,
        }
      : { offsetPercent: null, widthPercent: null };

  return {
    step,
    shape,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
    durationMs: shape === 'closed' ? closedDuration(step.startedAt, step.completedAt) : null,
    ...positioned,
  };
}

function shapeOf(step: StepView): TimelineShape {
  if (step.startedAt === null) return 'end-only';
  if (step.completedAt === null) return 'open';

  const startMs = epochOf(step.startedAt);
  const completedMs = epochOf(step.completedAt);

  if (startMs === null || completedMs === null) return 'open';

  return completedMs < startMs ? 'reversed' : 'closed';
}

/**
 * Where the bar ends.
 *
 * `open` runs to the end of the window — a step that has started and not finished occupies
 * the rest of the observed run, and that is the honest picture. `end-only` and `reversed` are
 * zero-width markers at their anchor: neither has an interval the system observed.
 */
function boundedEndMs(
  step: StepView,
  shape: TimelineShape,
  window: TimelineWindow | null,
): number | null {
  switch (shape) {
    case 'closed':
      return epochOf(step.completedAt);
    case 'open':
      return window?.endMs ?? null;
    case 'end-only':
    case 'reversed':
      return epochOf(anchorOf(step));
  }
}

/** Client-clock duration, or null unless both instants are present and correctly ordered. */
function closedDuration(startedAt: string | null, completedAt: string | null): number | null {
  const startMs = epochOf(startedAt);
  const endMs = epochOf(completedAt);

  if (startMs === null || endMs === null || endMs < startMs) return null;

  return endMs - startMs;
}

/**
 * `Date.parse`, with the unparseable case named.
 *
 * `TimestampSchema` has already rejected anything that is not an ISO instant by the time a
 * value reaches here — `runs-api.ts` `safeParse`s the whole response — so this branch is
 * unreachable through the real read path. It returns null rather than `NaN` because `NaN`
 * propagates silently through the arithmetic above and comes out the far end as a bar with
 * no position at all, which renders as a chart rather than as a problem.
 */
function epochOf(iso: string | null): number | null {
  if (iso === null) return null;

  const ms = Date.parse(iso);

  return Number.isNaN(ms) ? null : ms;
}

/** How many steps the timeline accounts for — the invariant the page states out loud. */
export function countTimelineSteps(timeline: RunTimeline): number {
  return timeline.entries.length + timeline.unplaced.length;
}

/**
 * The anomaly clause the Timeline header states out loud, or `''` when nothing is odd.
 *
 * Same contract as `describeStepAnomalies`, and here for the same reason: `open`, `end-only`
 * and `reversed` bars are all drawn, and a header that counts none of them lets a reader scan
 * "7 steps" over an axis where three of the bars are not measurements.
 *
 * `open` is not in the clause. A running step is the normal state of a running run, not an
 * anomaly; its own bar is marked where a reader can see it against the run's status.
 */
export function describeTimelineAnomalies(timeline: RunTimeline): string {
  const endOnly = timeline.entries.filter((entry) => entry.shape === 'end-only').length;
  const reversed = timeline.entries.filter((entry) => entry.shape === 'reversed').length;
  const unplaced = timeline.unplaced.length;

  return (
    (endOnly > 0 ? ` · ${String(endOnly)} completed before any start` : '') +
    (reversed > 0 ? ` · ${String(reversed)} with a reversed client clock` : '') +
    (unplaced > 0 ? ` · ${String(unplaced)} with no client clock` : '')
  );
}

/**
 * A duration a reader can compare at a glance, from a client-clock millisecond count.
 *
 * Fixed to milliseconds under a second and to three decimals above it, so the column is
 * scannable and no value is rounded away to `0s`. `null` is `'—'` rather than `'0ms'`: "we
 * did not observe this" and "it took no time" are different claims.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${String(ms)}ms`;

  return `${(ms / 1000).toFixed(3)}s`;
}
