import { describe, expect, it } from 'vitest';
import type {
  DecisionView,
  ErrorView,
  ModelCallView,
  RunDetailView,
  ToolCallView,
} from '@lengentic/shared/read';
import {
  assessIngestionHealth,
  describeCollection,
  formatByteCount,
  formatCount,
  readRunTelemetry,
  readToolCallClock,
} from './run-telemetry';

/**
 * The negative fixtures come first, deliberately — `CLAUDE.md` ## Product claims: "write the
 * negative fixtures before the positive path".
 *
 * Every function under test here exists to keep two facts apart that a renderer collapses by
 * default: **"the response did not carry this"** and **"there is none of this"**. The positive
 * path — a run with decisions, calls and errors — is the easy half and is exercised last. The
 * half that decides whether this module is worth having is a run the API answered without the
 * Phase 4 collections at all, which is what every deployment older than `p4.read-model`
 * returns and what `GET /v1/runs/:id` returns today for the four event types nothing ingests.
 */

const RUN_ID = 'run-telemetry';

/**
 * A run that carries **none of the four Phase 4 collections**.
 *
 * The omission is the fixture. `RunDetailViewSchema` marks `decisions`, `modelCalls`,
 * `toolCalls` and `errors` `.optional()` — nine lines of rationale in
 * `platform/shared/read/run-view.ts` say why `.default([])` was rejected — and this literal
 * is one of the few places in the repo where that optionality is load-bearing at compile
 * time: it is typed `RunDetailView` while naming none of the four, so a `.default([])` on any
 * of them makes this file stop compiling. Do not "complete" this object.
 */
function runWithout(overrides: Partial<RunDetailView> = {}): RunDetailView {
  return {
    id: RUN_ID,
    traceId: 'trace-telemetry',
    workflowName: 'checkout-agent',
    workflowVersion: '1.4.0',
    status: 'COMPLETED',
    startedAt: '2026-08-21T11:00:00.000Z',
    completedAt: '2026-08-21T11:00:10.000Z',
    receivedAt: '2026-08-21T19:00:00.000Z',
    lastEventAt: '2026-08-21T19:00:00.000Z',
    metadata: null,
    steps: [],
    ...overrides,
  };
}

function decision(overrides: Partial<DecisionView> & { id: string }): DecisionView {
  return {
    runId: RUN_ID,
    stepId: 'step-01',
    decisionType: 'execution_strategy',
    contextKey: 'batch:small',
    contextKeyVersion: 'v1',
    rawContext: null,
    availableOptions: ['sequential', 'parallel'],
    selectedOption: 'parallel',
    outcome: 'SUCCESS',
    outcomeAttestedBy: 'CALLER',
    outcomeObservedAt: '2026-08-21T11:00:09.000Z',
    createdAt: '2026-08-21T11:00:01.000Z',
    ...overrides,
  };
}

function modelCall(overrides: Partial<ModelCallView> & { id: string }): ModelCallView {
  return {
    runId: RUN_ID,
    stepId: 'step-01',
    provider: 'anthropic',
    model: 'claude-opus-4',
    latencyMs: 1200,
    inputTokens: 900,
    outputTokens: 150,
    status: 'ok',
    metadata: null,
    createdAt: '2026-08-21T11:00:02.000Z',
    ...overrides,
  };
}

function toolCall(overrides: Partial<ToolCallView> & { id: string }): ToolCallView {
  return {
    runId: RUN_ID,
    stepId: 'step-01',
    toolName: 'search_orders',
    input: { query: 'refunds' },
    output: { hits: 3 },
    inputTruncated: false,
    outputTruncated: false,
    inputBytes: 24,
    outputBytes: 12,
    startedAt: '2026-08-21T11:00:03.000Z',
    completedAt: '2026-08-21T11:00:04.000Z',
    durationMs: 1000,
    success: true,
    error: null,
    ...overrides,
  };
}

function errorRow(overrides: Partial<ErrorView> & { id: string }): ErrorView {
  return {
    runId: RUN_ID,
    stepId: 'step-01',
    type: 'ToolTimeout',
    message: 'search_orders did not answer within 30s',
    metadata: null,
    createdAt: '2026-08-21T11:00:05.000Z',
    ...overrides,
  };
}

describe('readRunTelemetry — absent is not empty', () => {
  it('reports every collection the response did not carry as absent, never as none', () => {
    const telemetry = readRunTelemetry(runWithout());

    // `absent` on all four, and no row anywhere. The expected values are the fixture's own
    // omissions, transcribed by hand — nothing here is read back off the function.
    expect(telemetry).toStrictEqual({
      decisions: { presence: 'absent', rows: [] },
      modelCalls: { presence: 'absent', rows: [] },
      toolCalls: { presence: 'absent', rows: [] },
      errors: { presence: 'absent', rows: [] },
    });
  });

  it('reports a collection the response carried as an empty array as none, not as absent', () => {
    // The paired positive of the test above, and the whole point of the module: these two
    // responses differ by four characters on the wire and mean opposite things to a reader.
    const telemetry = readRunTelemetry(
      runWithout({ decisions: [], modelCalls: [], toolCalls: [], errors: [] }),
    );

    expect(telemetry).toStrictEqual({
      decisions: { presence: 'none', rows: [] },
      modelCalls: { presence: 'none', rows: [] },
      toolCalls: { presence: 'none', rows: [] },
      errors: { presence: 'none', rows: [] },
    });
  });

  it('keeps the two apart per collection — one absent beside one that reported none', () => {
    // A real deployment shape: `p4.entities` stores errors, and `entityKindOf` returns null
    // for `decision.recorded`, so a response can carry one collection and not another.
    const telemetry = readRunTelemetry(runWithout({ errors: [] }));

    expect(telemetry.errors.presence).toBe('none');
    expect(telemetry.decisions.presence).toBe('absent');
    expect(telemetry.modelCalls.presence).toBe('absent');
    expect(telemetry.toolCalls.presence).toBe('absent');
  });

  it('passes rows through in response order and reports them as some', () => {
    const first = decision({ id: 'decision-01' });
    const second = decision({ id: 'decision-02' });

    const telemetry = readRunTelemetry(runWithout({ decisions: [first, second] }));

    expect(telemetry.decisions.presence).toBe('some');
    expect(telemetry.decisions.rows).toStrictEqual([first, second]);
  });
});

describe('describeCollection — the sentence a card puts where its rows would be', () => {
  it('says the response did not carry them for absent, and says none for an empty array', () => {
    const absent = describeCollection('absent', 'decisions');
    const none = describeCollection('none', 'decisions');

    // Asserted as two different strings before either is asserted for content: a helper that
    // returned one sentence for both states would satisfy any `toContain` written about it.
    expect(absent).not.toBe(none);
    expect(absent).toBe(
      'This response did not carry decisions. That is not a claim that none occurred — the API did not answer the question.',
    );
    expect(none).toBe('The API reported no decisions for this run.');
  });

  it('has nothing to say when there are rows to render', () => {
    expect(describeCollection('some', 'decisions')).toBe('');
  });
});

describe('readToolCallClock — the client clocks arrive unrepaired', () => {
  it('finds nothing wrong with a call whose instants and duration agree', () => {
    expect(readToolCallClock(toolCall({ id: 'tool-01' }))).toStrictEqual({
      instantsReversed: false,
      durationNegative: false,
    });
  });

  it('flags a completion that precedes its start rather than reordering it', () => {
    // `durationMs` is the client's own measurement and is passed through, not recomputed
    // (`run-view.ts`, ToolCallView) — so a caller whose clock moved backwards between the two
    // events reaches this component with a positive duration and reversed instants, and both
    // halves of that contradiction have to survive to the page.
    const clock = readToolCallClock(
      toolCall({
        id: 'tool-02',
        startedAt: '2026-08-21T11:00:04.000Z',
        completedAt: '2026-08-21T11:00:03.000Z',
        durationMs: 1000,
      }),
    );

    expect(clock).toStrictEqual({ instantsReversed: true, durationNegative: false });
  });

  it('flags a negative duration independently of the instants', () => {
    const clock = readToolCallClock(toolCall({ id: 'tool-03', durationMs: -1000 }));

    expect(clock).toStrictEqual({ instantsReversed: false, durationNegative: true });
  });

  it('flags both when the caller reported both', () => {
    const clock = readToolCallClock(
      toolCall({
        id: 'tool-04',
        startedAt: '2026-08-21T11:00:04.000Z',
        completedAt: '2026-08-21T11:00:03.000Z',
        durationMs: -1000,
      }),
    );

    expect(clock).toStrictEqual({ instantsReversed: true, durationNegative: true });
  });
});

describe('assessIngestionHealth — what was lost, and what cannot be asked', () => {
  it('reports null rather than zero for every count whose collection was never carried', () => {
    // The failure this whole module exists to prevent. `0 inputs truncated` over a response
    // that carried no tool calls is a health report asserting a clean run from the absence of
    // a signal the API never sent — the same manufactured absence `droppedTelemetryEventCount`
    // refuses by reporting `null`.
    const health = assessIngestionHealth(runWithout());

    expect(health.toolInputsTruncated).toBeNull();
    expect(health.toolOutputsTruncated).toBeNull();
    expect(health.truncatedOriginalBytes).toBeNull();
    expect(health.toolCallsWithClockAnomaly).toBeNull();
    expect(health.modelCallsMissingInputTokens).toBeNull();
    expect(health.modelCallsMissingOutputTokens).toBeNull();
  });

  it('reports zero once the API has actually answered the question with an empty array', () => {
    // The paired positive. `none` is an answer and `0` is its honest rendering; `absent` is
    // not an answer and the test above pins that it never becomes one.
    const health = assessIngestionHealth(runWithout({ modelCalls: [], toolCalls: [] }));

    expect(health.toolInputsTruncated).toBe(0);
    expect(health.toolOutputsTruncated).toBe(0);
    expect(health.truncatedOriginalBytes).toBe(0);
    expect(health.toolCallsWithClockAnomaly).toBe(0);
    expect(health.modelCallsMissingInputTokens).toBe(0);
    expect(health.modelCallsMissingOutputTokens).toBe(0);
  });

  it('counts each truncated payload and totals the original bytes, not the stored ones', () => {
    // The DoD line "A 1MB tool output is truncated and flagged". `outputBytes` is the size
    // the SDK measured *before* §15's cap (`tool-call-events.ts`: "the SDK is the only party
    // that knows whether it truncated and what the original size was"), so the total below is
    // what was lost sight of — 1MB — and not the 32KB that survived.
    const health = assessIngestionHealth(
      runWithout({
        toolCalls: [
          toolCall({ id: 'tool-clean' }),
          toolCall({ id: 'tool-big-output', outputTruncated: true, outputBytes: 1_048_576 }),
          toolCall({ id: 'tool-big-input', inputTruncated: true, inputBytes: 65_536 }),
        ],
      }),
    );

    expect(health.toolInputsTruncated).toBe(1);
    expect(health.toolOutputsTruncated).toBe(1);
    expect(health.truncatedOriginalBytes).toBe(1_048_576 + 65_536);
  });

  it('counts a tool call whose client clock contradicts itself, once per call', () => {
    const health = assessIngestionHealth(
      runWithout({
        toolCalls: [
          toolCall({ id: 'tool-clean' }),
          // Both anomalies on one call — counted once, because the count is of calls.
          toolCall({
            id: 'tool-backwards',
            startedAt: '2026-08-21T11:00:04.000Z',
            completedAt: '2026-08-21T11:00:03.000Z',
            durationMs: -1000,
          }),
          toolCall({ id: 'tool-negative', durationMs: -5 }),
        ],
      }),
    );

    expect(health.toolCallsWithClockAnomaly).toBe(2);
  });

  it('counts a model call that reported no token count as missing, never as having used none', () => {
    // §13 marks exactly the two token fields optional and `run-view.ts` says why a `0` there
    // would be wrong: it reads as "this call used no tokens", a measurement nobody made.
    const health = assessIngestionHealth(
      runWithout({
        modelCalls: [
          modelCall({ id: 'call-complete' }),
          modelCall({ id: 'call-no-input', inputTokens: null }),
          modelCall({ id: 'call-neither', inputTokens: null, outputTokens: null }),
        ],
      }),
    );

    expect(health.modelCallsMissingInputTokens).toBe(2);
    expect(health.modelCallsMissingOutputTokens).toBe(1);
  });

  it('carries the presence of all four collections so a reader can see which were answered', () => {
    const health = assessIngestionHealth(
      runWithout({ errors: [errorRow({ id: 'error-01' })], toolCalls: [] }),
    );

    expect(health.collections).toStrictEqual([
      { label: 'Decisions', presence: 'absent', count: 0 },
      { label: 'Model calls', presence: 'absent', count: 0 },
      { label: 'Tool calls', presence: 'none', count: 0 },
      { label: 'Errors', presence: 'some', count: 1 },
    ]);
  });

  it('reports a run of nothing but errors without inventing an answer for the rest', () => {
    // "A run with only errors" — one of the four negative shapes this node was told to cover.
    const health = assessIngestionHealth(
      runWithout({ errors: [errorRow({ id: 'error-01' }), errorRow({ id: 'error-02' })] }),
    );

    expect(health.collections.map((entry) => entry.presence)).toStrictEqual([
      'absent',
      'absent',
      'absent',
      'some',
    ]);
    expect(health.toolInputsTruncated).toBeNull();
    expect(health.modelCallsMissingInputTokens).toBeNull();
  });
});

describe('the formatters — null is a word, never a zero', () => {
  it('formats a byte count that was never reported as a phrase and not as 0 bytes', () => {
    expect(formatByteCount(null)).toBe('not reported');
    expect(formatByteCount(0)).toBe('0 bytes');
    expect(formatByteCount(1)).toBe('1 byte');
    expect(formatByteCount(1024)).toBe('1,024 bytes');
    expect(formatByteCount(1_048_576)).toBe('1,048,576 bytes');
  });

  it('formats a count nobody reported as a phrase and not as 0', () => {
    // Used for both the provider's token counts and the health counts above — same rule.
    expect(formatCount(null)).toBe('not reported');
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1500)).toBe('1,500');
  });
});
