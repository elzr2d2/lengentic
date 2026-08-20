import { describe, expect, it } from 'vitest';

import {
  mergeEvent,
  resolveTerminalStatus,
  type EntityMergeState,
  type MergeEvent,
} from './merge-rules';

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
  it('start fields: first writer wins by occurredAt — a LATER-occurring second start never overwrites an earlier one', () => {
    const afterFirstStart = mergeEvent(undefined, startEvent({ fields: { name: 'first' } }));

    const afterSecondStart = mergeEvent(
      afterFirstStart,
      startEvent({
        eventId: 'evt-start-2',
        occurredAt: '2026-08-18T11:00:00.000Z', // later occurredAt — loses, regardless of processing order
        receivedAt: 4_000,
        fields: { name: 'second' },
      }),
    );

    expect(afterSecondStart.startFields).toEqual({ name: 'first' });
    expect(afterSecondStart.startedAt).toBe('2026-08-18T10:00:00.000Z');
  });

  it('start fields: an EARLIER-occurring start wins even when processed second — arrival order must not matter (ADR 0007 mirror, ruling Q1)', () => {
    const afterFirstArrival = mergeEvent(
      undefined,
      startEvent({
        eventId: 'evt-start-late',
        occurredAt: '2026-08-18T10:00:00.000Z',
        fields: { name: 'later-arrival' },
      }),
    );

    const afterEarlierArrivesSecond = mergeEvent(
      afterFirstArrival,
      startEvent({
        eventId: 'evt-start-early',
        occurredAt: '2026-08-18T09:00:00.000Z', // earlier occurredAt, arrives second — must still win
        receivedAt: 4_000,
        fields: { name: 'earlier-occurrence' },
      }),
    );

    expect(afterEarlierArrivesSecond.startedAt).toBe('2026-08-18T09:00:00.000Z');
    expect(afterEarlierArrivesSecond.startFields).toEqual({ name: 'earlier-occurrence' });
  });

  it("start fields: tester regression fixture [start@10:00, start@09:00] — startedAt ends at 09:00 with that event's fields", () => {
    const afterTen = mergeEvent(
      undefined,
      startEvent({
        eventId: 'evt-1000',
        occurredAt: '2026-08-18T10:00:00.000Z',
        fields: { name: 'ten' },
      }),
    );
    const afterNine = mergeEvent(
      afterTen,
      startEvent({
        eventId: 'evt-0900',
        occurredAt: '2026-08-18T09:00:00.000Z',
        fields: { name: 'nine' },
      }),
    );

    expect(afterNine.startedAt).toBe('2026-08-18T09:00:00.000Z');
    expect(afterNine.startFields).toEqual({ name: 'nine' });
  });

  it('start fields: reverse insertion order [start@09:00, start@10:00] — same result, startedAt is 09:00 (order-independence)', () => {
    const afterNine = mergeEvent(
      undefined,
      startEvent({
        eventId: 'evt-0900',
        occurredAt: '2026-08-18T09:00:00.000Z',
        fields: { name: 'nine' },
      }),
    );
    const afterTen = mergeEvent(
      afterNine,
      startEvent({
        eventId: 'evt-1000',
        occurredAt: '2026-08-18T10:00:00.000Z',
        fields: { name: 'ten' },
      }),
    );

    expect(afterTen.startedAt).toBe('2026-08-18T09:00:00.000Z');
    expect(afterTen.startFields).toEqual({ name: 'nine' });
  });

  it('start fields: equal occurredAt tie breaks on the lexicographically LESSER eventId, insertion order A-then-B (mirror of ADR 0007)', () => {
    const eventA = startEvent({
      eventId: 'evt-aaa',
      occurredAt: '2026-08-18T10:00:00.000Z',
      fields: { name: 'aaa' },
    });
    const eventB = startEvent({
      eventId: 'evt-bbb',
      occurredAt: '2026-08-18T10:00:00.000Z',
      fields: { name: 'bbb' },
    });

    const afterA = mergeEvent(undefined, eventA);
    const afterB = mergeEvent(afterA, eventB);

    expect(afterB.startFields).toEqual({ name: 'aaa' });
    expect(afterB.startEventId).toBe('evt-aaa');
  });

  it("start fields: a winning-but-metadata-less start event WHOLESALE REPLACES the prior winner's fields, including dropping metadata it never carried (D3: wholesale replace, not presence-merge, is what stays order-independent)", () => {
    const afterFirst = mergeEvent(
      undefined,
      startEvent({
        eventId: 'evt-with-metadata',
        occurredAt: '2026-08-18T10:00:00.000Z',
        fields: { name: 'first', metadata: { tenant: 'acme' } },
      }),
    );

    // Earlier occurredAt — wins the tie-break and becomes the new startEventId — but its own
    // payload never carried metadata at all. A prior attempt merged this event's fields onto
    // the previous winner's (presence-based merge) so `metadata` survived; that design was
    // reverted (tester finding D3) because the merge depended on which event this process
    // happened to fold in first, not only on the event SET. Wholesale replace is the
    // deliberately lossy, deterministic alternative: the winner's own fields are the whole
    // answer.
    const afterEarlierNoMetadata = mergeEvent(
      afterFirst,
      startEvent({
        eventId: 'evt-no-metadata',
        occurredAt: '2026-08-18T09:00:00.000Z',
        fields: { name: 'second' },
      }),
    );

    expect(afterEarlierNoMetadata.startEventId).toBe('evt-no-metadata');
    expect(afterEarlierNoMetadata.startFields).toEqual({ name: 'second' });
  });

  it('start fields: a winning event that DOES carry a key overrides the prior value for that key, including explicit null', () => {
    const afterFirst = mergeEvent(
      undefined,
      startEvent({
        eventId: 'evt-a',
        occurredAt: '2026-08-18T10:00:00.000Z',
        fields: { name: 'a', parentStepId: 'parent-1' },
      }),
    );

    const afterEarlierRoot = mergeEvent(
      afterFirst,
      startEvent({
        eventId: 'evt-b',
        occurredAt: '2026-08-18T09:00:00.000Z',
        fields: { name: 'b', parentStepId: null },
      }),
    );

    expect(afterEarlierRoot.startFields).toEqual({ name: 'b', parentStepId: null });
  });

  it('start fields: equal occurredAt tie breaks on the lexicographically LESSER eventId, insertion order B-then-A', () => {
    const eventA = startEvent({
      eventId: 'evt-aaa',
      occurredAt: '2026-08-18T10:00:00.000Z',
      fields: { name: 'aaa' },
    });
    const eventB = startEvent({
      eventId: 'evt-bbb',
      occurredAt: '2026-08-18T10:00:00.000Z',
      fields: { name: 'bbb' },
    });

    const afterB = mergeEvent(undefined, eventB);
    const afterA = mergeEvent(afterB, eventA);

    expect(afterA.startFields).toEqual({ name: 'aaa' });
    expect(afterA.startEventId).toBe('evt-aaa');
  });

  it('start fields: D3 regression — same two-event set (metadata-carrying loses to an earlier metadata-less start), both arrival orders drop metadata identically', () => {
    const withMetadata = startEvent({
      eventId: 'evt-a',
      occurredAt: '2026-08-18T10:00:05.000Z',
      fields: { name: 'a', metadata: { from: 'a' } },
    });
    const noMetadataEarlier = startEvent({
      eventId: 'evt-b',
      occurredAt: '2026-08-18T10:00:03.000Z',
      fields: { name: 'b' },
    });

    const aThenB = mergeEvent(mergeEvent(undefined, withMetadata), noMetadataEarlier);
    const bThenA = mergeEvent(mergeEvent(undefined, noMetadataEarlier), withMetadata);

    expect(aThenB.startFields).toEqual({ name: 'b' });
    expect(bThenA.startFields).toEqual({ name: 'b' });
    expect(aThenB.startEventId).toBe('evt-b');
    expect(bThenA.startEventId).toBe('evt-b');
  });

  it('start fields: D3 regression — exact occurredAt tie, metadata-less event has the lesser eventId and wins the tie, both arrival orders agree', () => {
    const withMetadata = startEvent({
      eventId: 'evt-z',
      occurredAt: '2026-08-18T10:00:03.000Z',
      fields: { name: 'z', metadata: { from: 'z' } },
    });
    const noMetadataTieWinner = startEvent({
      eventId: 'evt-a',
      occurredAt: '2026-08-18T10:00:03.000Z',
      fields: { name: 'a' },
    });

    const zThenA = mergeEvent(mergeEvent(undefined, withMetadata), noMetadataTieWinner);
    const aThenZ = mergeEvent(mergeEvent(undefined, noMetadataTieWinner), withMetadata);

    expect(zThenA.startFields).toEqual({ name: 'a' });
    expect(aThenZ.startFields).toEqual({ name: 'a' });
  });

  it("start fields: D3 — three-event set holds over all six permutations, mirroring the completion side's T-D", () => {
    const s1 = startEvent({
      eventId: 'evt-s1',
      occurredAt: '2026-08-18T10:00:05.000Z',
      fields: { name: 's1', metadata: { from: 's1' } },
    });
    const s2 = startEvent({
      eventId: 'evt-s2',
      occurredAt: '2026-08-18T10:00:03.000Z',
      fields: { name: 's2' },
    });
    const s3 = startEvent({
      eventId: 'evt-s3',
      occurredAt: '2026-08-18T10:00:03.000Z',
      fields: { name: 's3', metadata: { from: 's3' } },
    });

    const permutations: MergeEvent[][] = [
      [s1, s2, s3],
      [s1, s3, s2],
      [s2, s1, s3],
      [s2, s3, s1],
      [s3, s1, s2],
      [s3, s2, s1],
    ];

    for (const permutation of permutations) {
      const final = permutation.reduce<EntityMergeState | undefined>(
        (state, event) => mergeEvent(state, event),
        undefined,
      );

      // s2 and s3 tie at occurredAt 10:00:03; 's2' < 's3' lexicographically, so s2's eventId
      // wins the tie. s2 also has the earliest occurredAt overall, so s2 is the entity's
      // overall start winner regardless of processing order — and since s2's own fields
      // never carried metadata, the final startFields drop it (wholesale replace), for
      // EVERY permutation.
      expect(final?.startEventId).toBe('evt-s2');
      expect(final?.startedAt).toBe('2026-08-18T10:00:03.000Z');
      expect(final?.startFields).toEqual({ name: 's2' });
    }
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

  it('discriminates real instants from raw string order: an event whose ISO string sorts LOWER but names a LATER instant still wins (tester fixture)', () => {
    // evt-aaa: 2026-08-18T09:00:00.000Z — instant 09:00 UTC.
    // evt-zzz: 2026-08-18T11:30:00.000+03:00 — instant 08:30 UTC (11:30 minus the +03:00 offset).
    // Raw string comparison says '...T09:00...Z' < '...T11:30...+03:00' (the '09' < '11'
    // digits), so a naive lexicographic comparator would pick evt-zzz as "later" — the wrong
    // answer. `compareOccurredAt` uses `Date.parse`, so it must pick evt-aaa (the genuinely
    // later instant) regardless of which one is processed first.
    const eventAaa = completionEvent({
      eventId: 'evt-aaa',
      occurredAt: '2026-08-18T09:00:00.000Z',
      fields: { metadata: { from: 'aaa' } },
    });
    const eventZzz = completionEvent({
      eventId: 'evt-zzz',
      occurredAt: '2026-08-18T11:30:00.000+03:00',
      fields: { metadata: { from: 'zzz' } },
    });

    const aaaThenZzz = mergeEvent(mergeEvent(undefined, eventAaa), eventZzz);
    const zzzThenAaa = mergeEvent(mergeEvent(undefined, eventZzz), eventAaa);

    expect(aaaThenZzz.completedAt).toBe('2026-08-18T09:00:00.000Z');
    expect(aaaThenZzz.completionEventId).toBe('evt-aaa');
    expect(zzzThenAaa.completedAt).toBe('2026-08-18T09:00:00.000Z');
    expect(zzzThenAaa.completionEventId).toBe('evt-aaa');
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

  it('enrichment is a MERGE, not a replace: distinct top-level keys from an earlier completion survive a later one that does not repeat them (tester defect 2)', () => {
    const terminal = mergeEvent(
      undefined,
      completionEvent({
        eventId: 'evt-first',
        occurredAt: '2026-08-18T10:10:00.000Z',
        fields: { metadata: { errorMessage: 'boom', tokens: 42 } },
      }),
    );

    const enriched = mergeEvent(
      terminal,
      completionEvent({
        eventId: 'evt-second',
        occurredAt: '2026-08-18T10:20:00.000Z',
        fields: {},
      }),
    );

    // The second event carries no `metadata` key at all — the first event's payload must
    // not be silently dropped.
    expect(enriched.completionFields).toEqual({ metadata: { errorMessage: 'boom', tokens: 42 } });
  });

  it('enrichment merge: a later completion with a DIFFERENT top-level key is added alongside the earlier one, neither is lost', () => {
    const terminal = mergeEvent(
      undefined,
      completionEvent({
        eventId: 'evt-first',
        occurredAt: '2026-08-18T10:10:00.000Z',
        fields: { metadata: { errorMessage: 'boom' } },
      }),
    );

    const enriched = mergeEvent(
      terminal,
      completionEvent({
        eventId: 'evt-second',
        occurredAt: '2026-08-18T10:20:00.000Z',
        fields: { output: { retries: 2 } },
      }),
    );

    expect(enriched.completionFields).toEqual({
      metadata: { errorMessage: 'boom' },
      output: { retries: 2 },
    });
  });

  it('MUST NOT reopen the run — a duplicate/late start after a FAILED terminal leaves status untouched (tester defect 1)', () => {
    const terminal = mergeEvent(undefined, completionEvent({ status: 'FAILED' }));

    const afterLateStart = mergeEvent(
      terminal,
      startEvent({ eventId: 'evt-late-start', receivedAt: 9_000 }),
    );

    expect(afterLateStart.status).toBe('FAILED');
  });

  it('MUST NOT reopen the run — a duplicate/late start after a COMPLETED terminal leaves status untouched (tester defect 1)', () => {
    const terminal = mergeEvent(undefined, completionEvent({ status: 'COMPLETED' }));

    const afterLateStart = mergeEvent(
      terminal,
      startEvent({ eventId: 'evt-late-start', receivedAt: 9_000 }),
    );

    // Mutation-proof: flipping the start branch to spread `status` (or hardcode 'RUNNING')
    // must turn this assertion red. Confirmed manually — see
    // .artifacts/evidence/2/merge-rules-mutation.md.
    expect(afterLateStart.status).toBe('COMPLETED');
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

describe('mergeEvent — purity / aliasing (tester defect 4)', () => {
  it("start branch: mutating the caller's event.fields object after mergeEvent returns does not retroactively change the returned state", () => {
    const original: MergeEvent = startEvent({ fields: { name: 'original' } });

    const state = mergeEvent(undefined, original);
    // Deliberately mutating the caller's own object to prove the module copied it rather
    // than aliased it.
    (original.fields as Record<string, unknown>).name = 'mutated-after-the-fact';

    expect(state.startFields).toEqual({ name: 'original' });
  });

  it("completion branch: mutating the caller's event.fields object after mergeEvent returns does not retroactively change the returned state", () => {
    const original: MergeEvent = completionEvent({ fields: { metadata: { note: 'original' } } });

    const state = mergeEvent(undefined, original);
    // Deliberately mutating the caller's own object to prove the module copied it rather
    // than aliased it.
    (original.fields as Record<string, unknown>).metadata = { note: 'mutated-after-the-fact' };

    expect(state.completionFields).toEqual({ metadata: { note: 'original' } });
  });
});

describe('mergeEvent — per-key completion field provenance (ADR 0007 §3, tester defect: order-dependent completionFields)', () => {
  it('T-A: FAILED@10:00{error} + COMPLETED@10:10{output}, both arrival orders — completionFields merges both keys, status stays FAILED', () => {
    const failed = completionEvent({
      eventId: 'evt-failed',
      status: 'FAILED',
      occurredAt: '2026-08-18T10:00:00.000Z',
      fields: { error: 'boom' },
    });
    const completed = completionEvent({
      eventId: 'evt-completed',
      status: 'COMPLETED',
      occurredAt: '2026-08-18T10:10:00.000Z',
      fields: { output: 'done' },
    });

    const failedThenCompleted = mergeEvent(mergeEvent(undefined, failed), completed);
    const completedThenFailed = mergeEvent(mergeEvent(undefined, completed), failed);

    expect(failedThenCompleted.completionFields).toEqual({ error: 'boom', output: 'done' });
    expect(failedThenCompleted.status).toBe('FAILED');
    expect(completedThenFailed.completionFields).toEqual({ error: 'boom', output: 'done' });
    expect(completedThenFailed.status).toBe('FAILED');

    // T-F: the origins map is explicitly asserted, not merely written and never read.
    expect(failedThenCompleted.completionFieldOrigins).toEqual({
      error: { occurredAt: '2026-08-18T10:00:00.000Z', eventId: 'evt-failed' },
      output: { occurredAt: '2026-08-18T10:10:00.000Z', eventId: 'evt-completed' },
    });
    expect(completedThenFailed.completionFieldOrigins).toEqual({
      error: { occurredAt: '2026-08-18T10:00:00.000Z', eventId: 'evt-failed' },
      output: { occurredAt: '2026-08-18T10:10:00.000Z', eventId: 'evt-completed' },
    });
  });

  it('T-B: same key, different occurredAt, both orders — the later instant wins both times', () => {
    const earlier = completionEvent({
      eventId: 'evt-earlier',
      occurredAt: '2026-08-18T10:00:00.000Z',
      fields: { a: 'earlier' },
    });
    const later = completionEvent({
      eventId: 'evt-later',
      occurredAt: '2026-08-18T10:10:00.000Z',
      fields: { a: 'later' },
    });

    const earlierThenLater = mergeEvent(mergeEvent(undefined, earlier), later);
    const laterThenEarlier = mergeEvent(mergeEvent(undefined, later), earlier);

    expect(earlierThenLater.completionFields).toEqual({ a: 'later' });
    expect(laterThenEarlier.completionFields).toEqual({ a: 'later' });
  });

  it('T-C: same key, identical occurredAt, differing eventId, both orders — the greater eventId wins both times', () => {
    const eventA = completionEvent({
      eventId: 'evt-aaa',
      occurredAt: '2026-08-18T10:00:00.000Z',
      fields: { a: 'aaa' },
    });
    const eventB = completionEvent({
      eventId: 'evt-bbb',
      occurredAt: '2026-08-18T10:00:00.000Z',
      fields: { a: 'bbb' },
    });

    const aThenB = mergeEvent(mergeEvent(undefined, eventA), eventB);
    const bThenA = mergeEvent(mergeEvent(undefined, eventB), eventA);

    expect(aThenB.completionFields).toEqual({ a: 'bbb' });
    expect(bThenA.completionFields).toEqual({ a: 'bbb' });
  });

  it('T-D: three-event case holds over all six permutations — a "use completionEventId as proxy" design cannot pass this', () => {
    const e1 = completionEvent({
      eventId: 'evt-e1',
      occurredAt: '2026-08-18T10:00:00.000Z',
      fields: { a: 1 },
    });
    const e2 = completionEvent({
      eventId: 'evt-e2',
      occurredAt: '2026-08-18T10:10:00.000Z',
      fields: { a: 2, b: 9 },
    });
    const e3 = completionEvent({
      eventId: 'evt-e3',
      occurredAt: '2026-08-18T10:20:00.000Z',
      fields: {},
    });

    const permutations: MergeEvent[][] = [
      [e1, e2, e3],
      [e1, e3, e2],
      [e2, e1, e3],
      [e2, e3, e1],
      [e3, e1, e2],
      [e3, e2, e1],
    ];

    for (const permutation of permutations) {
      const final = permutation.reduce<EntityMergeState | undefined>(
        (state, event) => mergeEvent(state, event),
        undefined,
      );

      expect(final?.completionFields).toEqual({ a: 2, b: 9 });
      expect(final?.completedAt).toBe('2026-08-18T10:20:00.000Z');
      expect(final?.completionEventId).toBe('evt-e3');
    }
  });
});

describe('mergeEvent — nested aliasing (tester defect: purity claim only held for top-level keys)', () => {
  it('start branch: mutating a nested object inside the caller event fields after mergeEvent returns does not change the returned state', () => {
    const original: MergeEvent = startEvent({ fields: { config: { retries: 1 } } });

    const state = mergeEvent(undefined, original);
    (original.fields as { config: { retries: number } }).config.retries = 999;

    expect(state.startFields).toEqual({ config: { retries: 1 } });
  });

  it('completion branch: mutating a nested array inside the caller event fields after mergeEvent returns does not change the returned state', () => {
    const original: MergeEvent = completionEvent({ fields: { tags: ['a', 'b'] } });

    const state = mergeEvent(undefined, original);
    (original.fields as { tags: string[] }).tags.push('mutated-after-the-fact');

    expect(state.completionFields).toEqual({ tags: ['a', 'b'] });
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
