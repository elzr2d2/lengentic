import { describe, expect, it } from 'vitest';

import { mergeEvent, resolveTerminalStatus, type MergeEvent } from './merge-rules';

// Builders keep each test's intent visible — only the fields that matter for that
// assertion are ever spelled out at the call site.

function startEvent(overrides: Partial<MergeEvent> = {}): MergeEvent {
  return {
    eventId: 'evt-start-1',
    entityId: 'entity-1',
    occurredAt: '2026-08-18T10:00:00.000Z',
    receivedAt: 1_000,
    kind: 'start',
    fields: { name: 'root-step' },
    ...overrides,
  };
}

function completionEvent(overrides: Partial<MergeEvent> = {}): MergeEvent {
  return {
    eventId: 'evt-complete-1',
    entityId: 'entity-1',
    occurredAt: '2026-08-18T10:05:00.000Z',
    receivedAt: 2_000,
    kind: 'completion',
    status: 'COMPLETED',
    fields: { metadata: null },
    ...overrides,
  };
}

describe('mergeEvent — out-of-order start/completion (MVP_PLAN_V3.md §12)', () => {
  it('creates a new entity in RUNNING when the first event seen is a start', () => {
    const state = mergeEvent(undefined, startEvent());

    expect(state.status).toBe('RUNNING');
    expect(state.startedAt).toBe('2026-08-18T10:00:00.000Z');
    expect(state.completedAt).toBeNull();
  });

  it('a completion event for an unseen entityId creates the row already completed', () => {
    const state = mergeEvent(undefined, completionEvent({ status: 'FAILED' }));

    expect(state.status).toBe('FAILED');
    expect(state.completedAt).toBe('2026-08-18T10:05:00.000Z');
    expect(state.startedAt).toBeNull();
    expect(state.startFields).toBeNull();
  });

  it('a later-arriving start event fills start fields only — it never resets status', () => {
    const afterCompletion = mergeEvent(undefined, completionEvent({ status: 'COMPLETED' }));

    const afterLateStart = mergeEvent(
      afterCompletion,
      startEvent({ occurredAt: '2026-08-18T09:59:00.000Z', receivedAt: 3_000 }),
    );

    expect(afterLateStart.status).toBe('COMPLETED');
    expect(afterLateStart.startedAt).toBe('2026-08-18T09:59:00.000Z');
    expect(afterLateStart.startFields).toEqual({ name: 'root-step' });
    expect(afterLateStart.completedAt).toBe('2026-08-18T10:05:00.000Z');
  });
});

describe('mergeEvent — field precedence (MVP_PLAN_V3.md §12)', () => {
  it('start fields: first writer wins — a second start event never overwrites them', () => {
    const afterFirstStart = mergeEvent(undefined, startEvent({ fields: { name: 'first' } }));

    const afterSecondStart = mergeEvent(
      afterFirstStart,
      startEvent({
        eventId: 'evt-start-2',
        occurredAt: '2026-08-18T09:00:00.000Z', // earlier occurredAt — still loses, order is by processing
        receivedAt: 4_000,
        fields: { name: 'second' },
      }),
    );

    expect(afterSecondStart.startFields).toEqual({ name: 'first' });
    expect(afterSecondStart.startedAt).toBe('2026-08-18T10:00:00.000Z');
  });

  it('completion fields: last writer wins by occurredAt, not arrival order', () => {
    const earlier = completionEvent({
      eventId: 'evt-a',
      occurredAt: '2026-08-18T10:00:00.000Z',
      fields: { metadata: { note: 'earlier' } },
    });
    const later = completionEvent({
      eventId: 'evt-b',
      occurredAt: '2026-08-18T10:10:00.000Z',
      fields: { metadata: { note: 'later' } },
    });

    // Process the chronologically later event FIRST — arrival order must not matter.
    const afterLaterArrivesFirst = mergeEvent(undefined, later);
    const afterEarlierArrivesSecond = mergeEvent(afterLaterArrivesFirst, earlier);

    expect(afterEarlierArrivesSecond.completedAt).toBe('2026-08-18T10:10:00.000Z');
    expect(afterEarlierArrivesSecond.completionFields).toEqual({ metadata: { note: 'later' } });
  });

  it('equal occurredAt: the lexicographically greater eventId wins, insertion order A-then-B (ADR 0007)', () => {
    const eventA = completionEvent({
      eventId: 'evt-aaa',
      occurredAt: '2026-08-18T10:00:00.000Z',
      fields: { metadata: { from: 'aaa' } },
    });
    const eventB = completionEvent({
      eventId: 'evt-bbb',
      occurredAt: '2026-08-18T10:00:00.000Z',
      fields: { metadata: { from: 'bbb' } },
    });

    const afterA = mergeEvent(undefined, eventA);
    const afterB = mergeEvent(afterA, eventB);

    expect(afterB.completionFields).toEqual({ metadata: { from: 'bbb' } });
    expect(afterB.completionEventId).toBe('evt-bbb');
  });

  it('equal occurredAt: the lexicographically greater eventId wins, insertion order B-then-A (ADR 0007)', () => {
    const eventA = completionEvent({
      eventId: 'evt-aaa',
      occurredAt: '2026-08-18T10:00:00.000Z',
      fields: { metadata: { from: 'aaa' } },
    });
    const eventB = completionEvent({
      eventId: 'evt-bbb',
      occurredAt: '2026-08-18T10:00:00.000Z',
      fields: { metadata: { from: 'bbb' } },
    });

    const afterB = mergeEvent(undefined, eventB);
    const afterA = mergeEvent(afterB, eventA);

    // Same expected winner as the reverse insertion order above — the result is a pure
    // function of the event set, independent of arrival order (ADR 0007 Consequences).
    expect(afterA.completionFields).toEqual({ metadata: { from: 'bbb' } });
    expect(afterA.completionEventId).toBe('evt-bbb');
  });
});

describe('resolveTerminalStatus — conflicting terminal states (MVP_PLAN_V3.md §12, OD-3)', () => {
  it('FAILED beats COMPLETED regardless of which is passed as the existing status', () => {
    expect(resolveTerminalStatus('COMPLETED', 'FAILED')).toBe('FAILED');
    expect(resolveTerminalStatus('FAILED', 'COMPLETED')).toBe('FAILED');
  });

  it('agreeing statuses are unaffected', () => {
    expect(resolveTerminalStatus('COMPLETED', 'COMPLETED')).toBe('COMPLETED');
    expect(resolveTerminalStatus('FAILED', 'FAILED')).toBe('FAILED');
  });
});

describe('mergeEvent — conflicting terminal states end to end', () => {
  it('COMPLETED then FAILED: FAILED wins', () => {
    const afterCompleted = mergeEvent(undefined, completionEvent({ status: 'COMPLETED' }));
    const afterFailed = mergeEvent(
      afterCompleted,
      completionEvent({
        eventId: 'evt-fail',
        status: 'FAILED',
        occurredAt: '2026-08-18T10:06:00.000Z',
      }),
    );

    expect(afterFailed.status).toBe('FAILED');
  });

  it('FAILED then COMPLETED: FAILED still wins — order does not decide the outcome', () => {
    const afterFailed = mergeEvent(
      undefined,
      completionEvent({ eventId: 'evt-fail', status: 'FAILED' }),
    );
    const afterCompleted = mergeEvent(
      afterFailed,
      completionEvent({
        eventId: 'evt-complete',
        status: 'COMPLETED',
        occurredAt: '2026-08-18T10:06:00.000Z',
      }),
    );

    expect(afterCompleted.status).toBe('FAILED');
  });

  it('status resolution and completedAt/field resolution are independent: a later COMPLETED still updates completedAt even though FAILED still wins on status', () => {
    const afterFailed = mergeEvent(
      undefined,
      completionEvent({
        eventId: 'evt-fail',
        status: 'FAILED',
        occurredAt: '2026-08-18T10:00:00.000Z',
      }),
    );
    const afterLaterCompleted = mergeEvent(
      afterFailed,
      completionEvent({
        eventId: 'evt-complete',
        status: 'COMPLETED',
        occurredAt: '2026-08-18T10:10:00.000Z',
        fields: { metadata: { note: 'later-completed' } },
      }),
    );

    expect(afterLaterCompleted.status).toBe('FAILED');
    expect(afterLaterCompleted.completedAt).toBe('2026-08-18T10:10:00.000Z');
    expect(afterLaterCompleted.completionFields).toEqual({ metadata: { note: 'later-completed' } });
  });
});

describe('mergeEvent — late events on a terminal run', () => {
  it('are accepted, update lastEventAt, and may enrich the run', () => {
    const terminal = mergeEvent(undefined, completionEvent({ receivedAt: 1_000 }));

    const enriched = mergeEvent(
      terminal,
      completionEvent({
        eventId: 'evt-late',
        occurredAt: '2026-08-18T10:20:00.000Z',
        receivedAt: 9_000,
        fields: { metadata: { note: 'enrichment' } },
      }),
    );

    expect(enriched.lastEventAt).toBe(9_000);
    expect(enriched.completionFields).toEqual({ metadata: { note: 'enrichment' } });
  });

  it('MUST NOT reopen the run — a start event arriving after terminal status leaves status untouched', () => {
    const terminal = mergeEvent(undefined, completionEvent({ status: 'FAILED' }));

    const afterLateStart = mergeEvent(
      terminal,
      startEvent({ eventId: 'evt-late-start', receivedAt: 9_000 }),
    );

    expect(afterLateStart.status).toBe('FAILED');
  });

  it('lastEventAt is monotonic — never regresses even if an older event is processed later', () => {
    const first = mergeEvent(undefined, startEvent({ receivedAt: 5_000 }));

    const afterOlderReceipt = mergeEvent(
      first,
      completionEvent({ eventId: 'evt-slow-network', receivedAt: 1_000 }),
    );

    expect(afterOlderReceipt.lastEventAt).toBe(5_000);
  });
});

describe('mergeEvent — orphans', () => {
  it('a step start event referencing a nonexistent parentStepId is accepted, not rejected or validated', () => {
    const state = mergeEvent(
      undefined,
      startEvent({ fields: { name: 'child-step', parentStepId: 'parent-does-not-exist' } }),
    );

    expect(state.status).toBe('RUNNING');
    expect(state.startFields).toEqual({
      name: 'child-step',
      parentStepId: 'parent-does-not-exist',
    });
  });
});

describe('mergeEvent — malformed calls', () => {
  it('throws when a completion event is passed without a status', () => {
    const eventWithoutStatus: MergeEvent = {
      eventId: 'evt-no-status',
      entityId: 'entity-1',
      occurredAt: '2026-08-18T10:05:00.000Z',
      receivedAt: 2_000,
      kind: 'completion',
      fields: {},
    };

    expect(() => mergeEvent(undefined, eventWithoutStatus)).toThrow();
  });
});
