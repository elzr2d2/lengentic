import { describe, expect, it } from 'vitest';

import {
  sourceWatermarkOf,
  toEngineDecisionRecord,
  toEngineDecisionRecords,
  toEngineOutcome,
  toEngineOutcomeAttestedBy,
  type AnalysisDecisionSource,
  type AnalysisLiveness,
} from './analysis-source';

/**
 * Seam: the four exported functions that turn stored rows into what the engine aggregates.
 * They are pure and take every input explicitly — no clock, no config, no database — so this
 * is the whole surface.
 *
 * Expected values are §18's exclusion rules, §39's STALE rule (`MVP_PLAN_V3.md:595`) and
 * §21's `sourceWatermark` definition, transcribed. None is read off the implementation.
 *
 * The negative cases come first, deliberately: every one of them is a row that must NOT
 * become a record, and a filter that quietly stopped filtering would produce a group whose
 * dominance figure is computed over rows sharing nothing but their gaps — the false positive
 * `CLAUDE.md` ## Product claims names as the failure mode that kills this product.
 */

const NOW = new Date('2026-09-04T12:00:00.000Z');
const THRESHOLD_MS = 1_800_000;
const LIVENESS: AnalysisLiveness = { now: NOW, staleThresholdMs: THRESHOLD_MS };

function source(overrides: Partial<AnalysisDecisionSource> = {}): AnalysisDecisionSource {
  return {
    decisionId: 'dec-1',
    runId: 'run-1',
    runStatus: 'COMPLETED',
    runLastEventAt: new Date('2026-09-04T11:00:00.000Z'),
    workflowName: 'demo-workflow',
    workflowVersion: 'a1b2c3d',
    decisionType: 'run_tests_after_code_change',
    contextKey: 'post_refactor_large_diff',
    contextKeyVersion: 'v1',
    availableOptions: ['YES', 'NO'],
    selectedOption: 'YES',
    outcome: 'SUCCESS',
    outcomeAttestedBy: 'CALLER',
    createdAt: new Date('2026-09-04T10:00:00.000Z'),
    ...overrides,
  };
}

describe('toEngineDecisionRecord — the rows that have no §18 group to be excluded from', () => {
  // Each of the four group-key members plus `selectedOption`, one at a time. A single test
  // over an all-null row would pass with four of the five conditions deleted.
  it.each([
    ['workflowName', { workflowName: null }],
    ['workflowVersion', { workflowVersion: null }],
    ['decisionType', { decisionType: null }],
    ['contextKeyVersion', { contextKeyVersion: null }],
    ['selectedOption', { selectedOption: null }],
  ] as const)('drops a row with no %s rather than inventing a group for it', (_name, missing) => {
    expect(toEngineDecisionRecord(source(missing), LIVENESS)).toBeNull();
  });

  it('KEEPS a row with no contextKey — that is §18 missingContextKey exclusion, counted in a group', () => {
    // The distinction the four above rest on: a null `contextKey` has a group and is excluded
    // WITHIN it, so filtering it here would delete the exclusion count the Dashboard renders.
    const record = toEngineDecisionRecord(source({ contextKey: null }), LIVENESS);

    expect(record).not.toBeNull();
    expect(record?.contextKey).toBeNull();
  });

  it('copies every field the engine groups and counts on', () => {
    const record = toEngineDecisionRecord(source(), LIVENESS);

    expect(record).toStrictEqual({
      decisionId: 'dec-1',
      runId: 'run-1',
      runIsStale: false,
      workflowName: 'demo-workflow',
      workflowVersion: 'a1b2c3d',
      decisionType: 'run_tests_after_code_change',
      contextKey: 'post_refactor_large_diff',
      contextKeyVersion: 'v1',
      availableOptions: ['YES', 'NO'],
      selectedOption: 'YES',
      outcome: 'SUCCESS',
      outcomeAttestedBy: 'CALLER',
    });
  });
});

describe('toEngineDecisionRecord — §39 STALE rule as the engine sees it', () => {
  it('marks a RUNNING run idle PAST the threshold stale', () => {
    const record = toEngineDecisionRecord(
      source({
        runStatus: 'RUNNING',
        runLastEventAt: new Date(NOW.getTime() - THRESHOLD_MS - 1),
      }),
      LIVENESS,
    );

    expect(record?.runIsStale).toBe(true);
  });

  it('leaves a RUNNING run idle EXACTLY the threshold live — §39 is a strict >', () => {
    const record = toEngineDecisionRecord(
      source({ runStatus: 'RUNNING', runLastEventAt: new Date(NOW.getTime() - THRESHOLD_MS) }),
      LIVENESS,
    );

    expect(record?.runIsStale).toBe(false);
  });

  it('never calls a COMPLETED run stale, however long ago it last spoke', () => {
    // §39 conditions STALE on RUNNING. A finished run is not idle; it is finished.
    const record = toEngineDecisionRecord(
      source({ runStatus: 'COMPLETED', runLastEventAt: new Date('2020-01-01T00:00:00.000Z') }),
      LIVENESS,
    );

    expect(record?.runIsStale).toBe(false);
  });
});

describe('toEngineDecisionRecords', () => {
  it('SKIPS an ungroupable row and keeps every row after it', () => {
    // A `for` loop that returned on the first null instead of continuing would silently drop
    // the tail of history behind one attestation-first row, and the group it produced would
    // still look like a well-formed answer.
    const records = toEngineDecisionRecords(
      [
        source({ decisionId: 'dec-1' }),
        source({ decisionId: 'dec-bad', decisionType: null }),
        source({ decisionId: 'dec-2' }),
        source({ decisionId: 'dec-3' }),
      ],
      LIVENESS,
    );

    expect(records.map((record) => record.decisionId)).toStrictEqual(['dec-1', 'dec-2', 'dec-3']);
  });

  it('preserves read order, which is what makes two runs over one database comparable', () => {
    const records = toEngineDecisionRecords(
      [source({ decisionId: 'dec-a' }), source({ decisionId: 'dec-b' })],
      LIVENESS,
    );

    expect(records.map((record) => record.decisionId)).toStrictEqual(['dec-a', 'dec-b']);
  });

  it('produces nothing from nothing', () => {
    expect(toEngineDecisionRecords([], LIVENESS)).toStrictEqual([]);
  });
});

describe('sourceWatermarkOf — §21 "what data range it was computed over"', () => {
  const OLDEST = new Date('2026-09-01T08:00:00.000Z');
  const MIDDLE = new Date('2026-09-02T08:00:00.000Z');
  const NEWEST = new Date('2026-09-03T08:00:00.000Z');

  it('is the NEWEST instant read, not the oldest — the range upper bound', () => {
    // Analysis is a full recomputation from the beginning of history (§22), so the range has
    // one moving end and this is it. The oldest row is the range's fixed start, and reporting
    // it would describe a window that never moves however much data arrives.
    expect(
      sourceWatermarkOf([
        source({ createdAt: OLDEST }),
        source({ createdAt: NEWEST }),
        source({ createdAt: MIDDLE }),
      ]),
    ).toStrictEqual(NEWEST);
  });

  it('finds the newest wherever it sits — first, last, or alone', () => {
    expect(
      sourceWatermarkOf([source({ createdAt: NEWEST }), source({ createdAt: OLDEST })]),
    ).toStrictEqual(NEWEST);
    expect(
      sourceWatermarkOf([source({ createdAt: OLDEST }), source({ createdAt: NEWEST })]),
    ).toStrictEqual(NEWEST);
    expect(sourceWatermarkOf([source({ createdAt: MIDDLE })])).toStrictEqual(MIDDLE);
  });

  it('counts the rows it READ, not the rows it could group', () => {
    // The newest row here is one no group can contain. The range still describes what was
    // looked at: a row dropped for a missing group key was inside the window.
    expect(
      sourceWatermarkOf([
        source({ createdAt: OLDEST }),
        source({ createdAt: NEWEST, decisionType: null }),
      ]),
    ).toStrictEqual(NEWEST);
  });

  it('is null when nothing was read, so the caller resolves it against its own clock', () => {
    expect(sourceWatermarkOf([])).toBeNull();
  });
});

describe('storage vocabulary → engine vocabulary', () => {
  it('maps every §13 outcome by name', () => {
    expect(toEngineOutcome('SUCCESS')).toBe('SUCCESS');
    expect(toEngineOutcome('FAILURE')).toBe('FAILURE');
    expect(toEngineOutcome('UNKNOWN')).toBe('UNKNOWN');
  });

  it('maps §14 two attestation sources by name', () => {
    expect(toEngineOutcomeAttestedBy('CALLER')).toBe('CALLER');
    expect(toEngineOutcomeAttestedBy('UNKNOWN')).toBe('UNKNOWN');
  });
});
