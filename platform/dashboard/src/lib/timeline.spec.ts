import { describe, expect, it } from 'vitest';
import type { RunDetailView, StepView } from '@lengentic/shared/read';
import {
  buildRunTimeline,
  countTimelineSteps,
  describeTimelineAnomalies,
  formatDuration,
  type RunTimeline,
} from './timeline';

/**
 * `buildRunTimeline` — the Execution Timeline's arithmetic.
 *
 * ## The seam
 *
 * `RunDetailView` in, `RunTimeline` out. Nothing here renders; the page-level alarm that the
 * timeline is actually on screen lives in `../app/runs/runs-pages.spec.ts`, which reads it out
 * of the emitted markup. Both are needed for the same reason `step-tree.spec.ts` was not
 * enough on its own: a correct computation the page does not render looks exactly like a run
 * with nothing to show.
 *
 * ## Why every fixture's server clocks are hours away from its client clocks
 *
 * `MVP_PLAN_V3.md:493` — "Never combine client and server clocks in one duration calculation."
 * `StepView` carries four `TimestampSchema` fields and the type system does not distinguish
 * them: `startedAt`/`completedAt` are the caller's clock, `receivedAt` is the server's. A
 * timeline that reached for `receivedAt` would still compile, still render, and still look
 * entirely plausible — it would just be charting ingestion latency and labelling it execution.
 *
 * So `receivedAt` here is deliberately **not** near the client instants: `STEP_RECEIVED_AT` is
 * eight hours later, and `RUN_RECEIVED_AT`/`lastEventAt` are two hours earlier. Every window
 * boundary and every percentage asserted below is computed by hand from the client instants
 * only, and each is a value the server clocks cannot produce — so a module that read the wrong
 * field fails here rather than shipping.
 */

/** Server clock, and far from the client's. Nothing computed below may depend on it. */
const STEP_RECEIVED_AT = '2026-08-21T19:00:00.000Z';
const RUN_RECEIVED_AT = '2026-08-21T09:00:00.000Z';

/**
 * A ten-second run, in client time: `11:00:00.000` → `11:00:10.000`.
 *
 * Ten seconds is chosen so every percentage below is exact in binary and can be checked in
 * one's head: `2.5s` is `25%`, `5s` is `50%`, `7.5s` is `75%`, `9s` is `90%`.
 */
const RUN_STARTED_AT = '2026-08-21T11:00:00.000Z';
const RUN_COMPLETED_AT = '2026-08-21T11:00:10.000Z';

function step(overrides: Partial<StepView> & { id: string }): StepView {
  return {
    runId: 'run-clock',
    parentStepId: null,
    name: overrides.id,
    agentName: 'checkout-agent',
    type: 'execute',
    status: 'COMPLETED',
    startedAt: null,
    completedAt: null,
    receivedAt: STEP_RECEIVED_AT,
    metadata: null,
    ...overrides,
  };
}

function run(steps: readonly StepView[], overrides: Partial<RunDetailView> = {}): RunDetailView {
  return {
    id: 'run-clock',
    traceId: 'trace-clock',
    workflowName: 'checkout-agent',
    workflowVersion: '1.4.0',
    status: 'COMPLETED',
    startedAt: RUN_STARTED_AT,
    completedAt: RUN_COMPLETED_AT,
    receivedAt: RUN_RECEIVED_AT,
    lastEventAt: RUN_RECEIVED_AT,
    metadata: null,
    ...overrides,
    steps: [...steps],
  };
}

/** One shape of each kind the timeline distinguishes, declared out of client-clock order. */
const FOUR_SHAPES = [
  // 9.0s in, and its completion precedes its start: a client clock that moved backwards.
  step({
    id: 'step-d-reversed',
    startedAt: '2026-08-21T11:00:09.000Z',
    completedAt: '2026-08-21T11:00:08.000Z',
  }),
  // 7.5s in, completion only — §12's "completion event for an unseen entityId".
  step({ id: 'step-c-end-only', completedAt: '2026-08-21T11:00:07.500Z' }),
  // 0.0s in, 2.5s long.
  step({
    id: 'step-a-closed',
    startedAt: RUN_STARTED_AT,
    completedAt: '2026-08-21T11:00:02.500Z',
  }),
  // 5.0s in, still running.
  step({ id: 'step-b-open', startedAt: '2026-08-21T11:00:05.000Z', status: 'RUNNING' }),
] as const;

/** The derived fields of one row, as a reader would read them. Keeps assertions on one line. */
function rows(timeline: RunTimeline): {
  id: string;
  shape: string;
  durationMs: number | null;
  offsetPercent: number | null;
  widthPercent: number | null;
}[] {
  return timeline.entries.map((entry) => ({
    id: entry.step.id,
    shape: entry.shape,
    durationMs: entry.durationMs,
    offsetPercent: entry.offsetPercent,
    widthPercent: entry.widthPercent,
  }));
}

describe('buildRunTimeline — the axis', () => {
  it('spans the earliest to the latest CLIENT instant, never a server one', () => {
    // Hand-computed: the client instants present are the run's 11:00:00 and 11:00:10 and the
    // four steps' 11:00:00 … 11:00:09. Min 11:00:00, max 11:00:10, span 10_000ms.
    //
    // The decoy: `receivedAt` on every step is 19:00:00 and the run's is 09:00:00. A window
    // computed from those would be 09:00:00 → 19:00:00 — ten HOURS — so this assertion is the
    // one that fails if the module ever reaches for the server clock.
    const timeline = buildRunTimeline(run(FOUR_SHAPES));

    expect(timeline.window).toStrictEqual({
      startMs: Date.parse('2026-08-21T11:00:00.000Z'),
      endMs: Date.parse('2026-08-21T11:00:10.000Z'),
      spanMs: 10_000,
      startedAt: '2026-08-21T11:00:00.000Z',
      endsAt: '2026-08-21T11:00:10.000Z',
    });
  });

  it('includes the run’s own instants in the window, so a late first step shows its gap', () => {
    // The run starts at 11:00:00 and its only step does not begin until 11:00:05. Anchoring
    // the axis on the first step would move the origin and hide the five-second gap, which is
    // exactly the observation someone opens a timeline to make.
    const timeline = buildRunTimeline(
      run([
        step({
          id: 'step-late',
          startedAt: '2026-08-21T11:00:05.000Z',
          completedAt: '2026-08-21T11:00:06.000Z',
        }),
      ]),
    );

    expect(timeline.window?.startedAt).toBe(RUN_STARTED_AT);
    // 5s into a 10s window, 1s long.
    expect(rows(timeline)).toStrictEqual([
      {
        id: 'step-late',
        shape: 'closed',
        durationMs: 1000,
        offsetPercent: 50,
        widthPercent: 10,
      },
    ]);
  });

  it('reports the run’s duration from the run’s own client instants, not from the window', () => {
    // A step whose client clock overshoots its run's completion stretches the WINDOW — that is
    // the honest picture of what was reported — but it must not stretch the run's stated
    // duration, which is `completedAt - startedAt` and nothing else.
    const timeline = buildRunTimeline(
      run([
        step({
          id: 'step-overshoot',
          startedAt: '2026-08-21T11:00:05.000Z',
          completedAt: '2026-08-21T11:00:30.000Z',
        }),
      ]),
    );

    expect(timeline.window?.endsAt).toBe('2026-08-21T11:00:30.000Z');
    // 11:00:10.000 − 11:00:00.000, by hand.
    expect(timeline.runDurationMs).toBe(10_000);
  });

  it('has no duration for a run that has not completed', () => {
    expect(
      buildRunTimeline(run([], { status: 'RUNNING', completedAt: null })).runDurationMs,
    ).toBeNull();
  });

  it('has no window at all when the run carries no client instant', () => {
    // Reachable: §12 lets any event create the Run row, and `run.started` is the only event
    // that supplies `startedAt`. Every server clock in this fixture is still present and set.
    const timeline = buildRunTimeline(
      run([step({ id: 'step-clockless' })], {
        status: 'RUNNING',
        startedAt: null,
        completedAt: null,
      }),
    );

    expect(timeline.window).toBeNull();
    expect(timeline.runDurationMs).toBeNull();
  });
});

describe('buildRunTimeline — placement', () => {
  it('places each shape at its client instant, with the width its evidence supports', () => {
    // Expected values computed by hand from the fixture's client instants against the 10s
    // window, never read back off the function:
    //
    //   step-a-closed    0.0s → 2.5s   offset  0%   width 25%   duration 2500ms
    //   step-b-open      5.0s → (open) offset 50%   width 50%   duration null
    //   step-c-end-only  7.5s (end)    offset 75%   width  0%   duration null
    //   step-d-reversed  9.0s → 8.0s   offset 90%   width  0%   duration null
    //
    // The order is the client clock's, and it is NOT the fixture's declaration order
    // (d, c, a, b) — which is what "ordered by the caller's occurredAt, not by arrival" means.
    const timeline = buildRunTimeline(run(FOUR_SHAPES));

    expect(rows(timeline)).toStrictEqual([
      {
        id: 'step-a-closed',
        shape: 'closed',
        durationMs: 2500,
        offsetPercent: 0,
        widthPercent: 25,
      },
      { id: 'step-b-open', shape: 'open', durationMs: null, offsetPercent: 50, widthPercent: 50 },
      {
        id: 'step-c-end-only',
        shape: 'end-only',
        durationMs: null,
        offsetPercent: 75,
        widthPercent: 0,
      },
      {
        id: 'step-d-reversed',
        shape: 'reversed',
        durationMs: null,
        offsetPercent: 90,
        widthPercent: 0,
      },
    ]);
  });

  it('gives a reversed client clock no duration rather than clamping it to zero', () => {
    // The paired negative for the row above. `0` would be a bar asserting an instantaneous
    // step — a measurement the system never made — where `null` renders as "—".
    const reversed = buildRunTimeline(run(FOUR_SHAPES)).entries.find(
      (entry) => entry.step.id === 'step-d-reversed',
    );

    expect(reversed?.durationMs).toBeNull();
    expect(formatDuration(reversed?.durationMs ?? null)).toBe('—');
  });

  it('breaks a client-clock tie on step id, so the order does not depend on the array’s', () => {
    // Declared z-then-a; both start on the same instant. Without the tie-break the rendered
    // order would follow whatever order the API happened to return.
    const sameInstant = [
      step({ id: 'step-z', startedAt: '2026-08-21T11:00:03.000Z' }),
      step({ id: 'step-a', startedAt: '2026-08-21T11:00:03.000Z' }),
    ];

    expect(buildRunTimeline(run(sameInstant)).entries.map((entry) => entry.step.id)).toStrictEqual([
      'step-a',
      'step-z',
    ]);
  });

  it('draws no bar when every client instant in the run is the same one', () => {
    // A zero-width window has no fraction to be a fraction of. `0%` would render as a chart
    // and read as an ordering; `null` renders as "no axis".
    const instant = '2026-08-21T11:00:00.000Z';
    const timeline = buildRunTimeline(
      run([step({ id: 'step-a', startedAt: instant, completedAt: instant })], {
        startedAt: instant,
        completedAt: instant,
      }),
    );

    expect(timeline.window?.spanMs).toBe(0);
    expect(rows(timeline)).toStrictEqual([
      {
        id: 'step-a',
        shape: 'closed',
        durationMs: 0,
        offsetPercent: null,
        widthPercent: null,
      },
    ]);
  });
});

describe('buildRunTimeline — totality', () => {
  it('accounts for every step exactly once, placed or explicitly unplaced', () => {
    // The alarm `step-tree.spec.ts` has for the same failure: a timeline that silently drops
    // the rows it cannot position renders four of five steps and looks like a five-step run
    // that had four. §12 makes a step with neither client instant an ordinary shape — any
    // event may create the row — so this is a real input, not a defensive hypothetical.
    const steps = [...FOUR_SHAPES, step({ id: 'step-e-clockless' })];
    const timeline = buildRunTimeline(run(steps));

    expect(timeline.unplaced).toStrictEqual([{ step: steps[4], reason: 'no-client-clock' }]);
    expect(countTimelineSteps(timeline)).toBe(steps.length);
    // Placed ∪ unplaced = the input, as a set of ids. Sorted, because the timeline reorders.
    expect(
      [
        ...timeline.entries.map((entry) => entry.step.id),
        ...timeline.unplaced.map((unplaced) => unplaced.step.id),
      ].sort(),
    ).toStrictEqual(steps.map((each) => each.id).sort());
  });

  it('is empty, not broken, for a run with no steps', () => {
    const timeline = buildRunTimeline(run([]));

    expect(timeline.entries).toStrictEqual([]);
    expect(timeline.unplaced).toStrictEqual([]);
    expect(countTimelineSteps(timeline)).toBe(0);
  });
});

describe('describeTimelineAnomalies', () => {
  it('says nothing about a run whose steps all started and finished in order', () => {
    const timeline = buildRunTimeline(
      run([
        step({
          id: 'step-a',
          startedAt: RUN_STARTED_AT,
          completedAt: '2026-08-21T11:00:02.500Z',
        }),
      ]),
    );

    expect(describeTimelineAnomalies(timeline)).toBe('');
  });

  it('does not call a still-running step an anomaly', () => {
    // A running step is the normal state of a running run. Counting it would put a permanent
    // warning on every live run and train the reader to ignore the clause.
    const timeline = buildRunTimeline(
      run([step({ id: 'step-b', startedAt: '2026-08-21T11:00:05.000Z', status: 'RUNNING' })]),
    );

    expect(describeTimelineAnomalies(timeline)).toBe('');
  });

  it('counts each anomalous shape, so one does not hide the others', () => {
    // The lesson `describeStepAnomalies` records: a header that counts one anomaly and omits
    // the rest tells a reader scanning it that the one it names is the only one there is.
    const timeline = buildRunTimeline(run([...FOUR_SHAPES, step({ id: 'step-e-clockless' })]));

    expect(describeTimelineAnomalies(timeline)).toBe(
      ' · 1 completed before any start · 1 with a reversed client clock · 1 with no client clock',
    );
  });
});

describe('formatDuration', () => {
  it('distinguishes "not observed" from "took no time"', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(0)).toBe('0ms');
  });

  it('keeps sub-second durations in milliseconds and rounds nothing away', () => {
    expect(formatDuration(1)).toBe('1ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('reports a second or more in seconds, to the millisecond', () => {
    expect(formatDuration(1000)).toBe('1.000s');
    expect(formatDuration(2500)).toBe('2.500s');
    expect(formatDuration(63_001)).toBe('63.001s');
  });
});
