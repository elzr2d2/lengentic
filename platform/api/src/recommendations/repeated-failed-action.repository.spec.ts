import { describe, expect, it, vi } from 'vitest';

import {
  RecommendationsRepository,
  toRecommendationRecord,
  toRepeatedFailedActionRecord,
} from './recommendations.repository';
import { recommendationFingerprint } from './fingerprint';
import type { RepeatedFailedActionSighting } from './recommendation-record';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Seam: the statements `RecommendationsRepository` sends Prisma for §20.2 rows, plus the row
 * mappers' refusal of a row whose identity columns do not match its category.
 *
 * Same two kinds of assertion as `recommendations.repository.spec.ts`, for the same reasons: the
 * query shape (what is in `where`, `create`, `update`) catches a find-then-write rewrite that a
 * state-only assertion cannot, and a Prisma-semantics `upsert` fake observes "a re-sighting adds
 * no row" and "DISMISSED survives" rather than arguing them. Negative cases first.
 */

const OBSERVED_AT = new Date('2026-10-26T09:00:00.000Z');
const RE_OBSERVED_AT = new Date('2026-10-26T17:30:00.000Z');

const ACTION_KEY = { runId: 'run-1', toolName: 'run_tests', inputFingerprint: 'a1b2c3d4e5f60718' };

function sighting(overrides: Partial<RepeatedFailedActionSighting> = {}) {
  return {
    category: 'REPEATED_FAILED_ACTION',
    analyzerId: 'repeated-failed-action',
    analyzerVersion: '1.0.0',
    actionKey: ACTION_KEY,
    configSnapshot: { minConsecutiveFailures: 3 },
    sourceWatermark: new Date('2026-10-26T08:59:00.000Z'),
    evidence: { attemptCount: 3, toolCallIds: ['tc-1', 'tc-2', 'tc-3'] },
    counterexamples: [],
    observedAt: OBSERVED_AT,
    ...overrides,
  } satisfies RepeatedFailedActionSighting;
}

const FINGERPRINT = recommendationFingerprint({
  analyzerId: 'repeated-failed-action',
  analyzerVersion: '1.0.0',
  actionKey: ACTION_KEY,
});

interface UpsertArgs {
  readonly where: { readonly fingerprint: string };
  readonly create: Record<string, unknown>;
  readonly update: Record<string, unknown>;
}

function prismaOver(rows = new Map<string, Record<string, unknown>>()) {
  const recommendation = {
    upsert: vi.fn((args: UpsertArgs) => {
      const existing = rows.get(args.where.fingerprint);
      if (existing === undefined) {
        const created = { status: 'OPEN', statusNote: null, statusChangedAt: null, ...args.create };
        rows.set(args.where.fingerprint, created);
        return Promise.resolve(created);
      }
      const updated = { ...existing, ...args.update };
      rows.set(args.where.fingerprint, updated);
      return Promise.resolve(updated);
    }),
    findMany: vi.fn((_args?: unknown) => Promise.resolve([])),
    deleteMany: vi.fn((_args?: unknown) => Promise.resolve({ count: 2 })),
  };

  return {
    recommendation,
    repository: new RecommendationsRepository({
      client: { recommendation },
    } as unknown as PrismaService),
    rows,
  };
}

/** A row as Postgres returns it, §20.2 flavour, with every column present. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rec-9',
    category: 'REPEATED_FAILED_ACTION',
    analyzerId: 'repeated-failed-action',
    analyzerVersion: '1.0.0',
    workflowName: null,
    workflowVersion: null,
    decisionType: null,
    contextKeyVersion: null,
    runId: 'run-1',
    toolName: 'run_tests',
    inputFingerprint: 'a1b2c3d4e5f60718',
    configSnapshot: { minConsecutiveFailures: 3 },
    sourceWatermark: OBSERVED_AT,
    fingerprint: FINGERPRINT,
    evidence: { attemptCount: 3, toolCallIds: ['tc-1', 'tc-2', 'tc-3'] },
    counterexamples: [],
    firstSeenAt: OBSERVED_AT,
    lastSeenAt: OBSERVED_AT,
    status: 'OPEN',
    statusNote: null,
    statusChangedAt: null,
    createdAt: OBSERVED_AT,
    ...overrides,
  };
}

// Prisma's row type is structural; the fixtures above carry every column it has.
type MapperRow = Parameters<typeof toRepeatedFailedActionRecord>[0];
const asRow = (overrides: Record<string, unknown> = {}) => row(overrides) as unknown as MapperRow;

describe('row mappers refuse a row whose identity does not match its category', () => {
  it('toRepeatedFailedActionRecord throws on a DETERMINISTIC_CANDIDATE row', () => {
    expect(() =>
      toRepeatedFailedActionRecord(asRow({ category: 'DETERMINISTIC_CANDIDATE' })),
    ).toThrow(/not REPEATED_FAILED_ACTION/);
  });

  it('toRecommendationRecord throws on a REPEATED_FAILED_ACTION row', () => {
    expect(() => toRecommendationRecord(asRow())).toThrow(/not DETERMINISTIC_CANDIDATE/);
  });

  it('throws on a §20.2 row missing any action-key column — a streak about nothing', () => {
    for (const column of ['runId', 'toolName', 'inputFingerprint']) {
      expect(() => toRepeatedFailedActionRecord(asRow({ [column]: null }))).toThrow(
        /missing an identity column/,
      );
    }
  });

  it('throws on a §20.1 row missing a group-key column', () => {
    expect(() =>
      toRecommendationRecord(
        asRow({
          category: 'DETERMINISTIC_CANDIDATE',
          workflowName: null,
          workflowVersion: 'v',
          decisionType: 'd',
          contextKeyVersion: 'v1',
        }),
      ),
    ).toThrow(/missing an identity column/);
  });

  it('throws on unreadable evidence rather than substituting one', () => {
    expect(() =>
      toRepeatedFailedActionRecord(asRow({ evidence: { attemptCount: 2, toolCallIds: [] } })),
    ).toThrow(/unreadable evidence/);
  });

  it('maps a well-formed row, action key and ordered evidence intact', () => {
    const record = toRepeatedFailedActionRecord(asRow());

    expect(record.actionKey).toStrictEqual(ACTION_KEY);
    expect(record.evidence.toolCallIds).toStrictEqual(['tc-1', 'tc-2', 'tc-3']);
    expect(record.counterexamples).toStrictEqual([]);
  });
});

describe('RecommendationsRepository.recordRepeatedFailedActionSighting', () => {
  it('upserts on the UNIQUE fingerprint, not find-then-write', async () => {
    const { repository, recommendation } = prismaOver();

    await repository.recordRepeatedFailedActionSighting(sighting());

    expect(recommendation.upsert).toHaveBeenCalledTimes(1);
    expect(recommendation.upsert.mock.calls[0]?.[0].where).toStrictEqual({
      fingerprint: FINGERPRINT,
    });
  });

  it('creates with the action-key columns and NO group-key columns', async () => {
    const { repository, recommendation } = prismaOver();

    await repository.recordRepeatedFailedActionSighting(sighting());

    const create = recommendation.upsert.mock.calls[0]?.[0].create as Record<string, unknown>;
    expect(create).toMatchObject({
      category: 'REPEATED_FAILED_ACTION',
      runId: 'run-1',
      toolName: 'run_tests',
      inputFingerprint: 'a1b2c3d4e5f60718',
      firstSeenAt: OBSERVED_AT,
    });
    for (const column of ['workflowName', 'workflowVersion', 'decisionType', 'contextKeyVersion']) {
      expect(create).not.toHaveProperty(column);
    }
  });

  it('re-states exactly five columns on update — never status, firstSeenAt or the note', async () => {
    const { repository, recommendation } = prismaOver();

    await repository.recordRepeatedFailedActionSighting(sighting());

    const update = recommendation.upsert.mock.calls[0]?.[0].update as Record<string, unknown>;
    expect(Object.keys(update).sort()).toStrictEqual(
      ['configSnapshot', 'counterexamples', 'evidence', 'lastSeenAt', 'sourceWatermark'].sort(),
    );
  });

  it('a second sighting of the same key adds no row and advances lastSeenAt only', async () => {
    const { repository, rows } = prismaOver();

    const first = await repository.recordRepeatedFailedActionSighting(sighting());
    const second = await repository.recordRepeatedFailedActionSighting(
      sighting({ observedAt: RE_OBSERVED_AT }),
    );

    expect(rows.size).toBe(1);
    expect(second.id).toBe(first.id);
    expect(second.firstSeenAt).toStrictEqual(OBSERVED_AT);
    expect(second.lastSeenAt).toStrictEqual(RE_OBSERVED_AT);
  });

  it('a DISMISSED streak stays DISMISSED across re-analysis', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const { repository } = prismaOver(rows);
    await repository.recordRepeatedFailedActionSighting(sighting());
    rows.set(FINGERPRINT, { ...rows.get(FINGERPRINT), status: 'DISMISSED', statusNote: 'known' });

    const again = await repository.recordRepeatedFailedActionSighting(
      sighting({ observedAt: RE_OBSERVED_AT }),
    );

    expect(again.status).toBe('DISMISSED');
    expect(again.statusNote).toBe('known');
  });

  it('a streak of a different run is a different recommendation', async () => {
    const { repository, rows } = prismaOver();

    await repository.recordRepeatedFailedActionSighting(sighting());
    await repository.recordRepeatedFailedActionSighting(
      sighting({ actionKey: { ...ACTION_KEY, runId: 'run-2' } }),
    );

    expect(rows.size).toBe(2);
  });
});

describe('RecommendationsRepository §20.2 withdrawal and reads', () => {
  it('deletes only §20.2 rows, never DISMISSED, never the emitted fingerprints', async () => {
    const { repository, recommendation } = prismaOver();

    const removed = await repository.withdrawRepeatedFailedActionsExcept(['fp-a', 'fp-b']);

    expect(recommendation.deleteMany).toHaveBeenCalledWith({
      where: {
        category: 'REPEATED_FAILED_ACTION',
        status: { not: 'DISMISSED' },
        fingerprint: { notIn: ['fp-a', 'fp-b'] },
      },
    });
    expect(removed).toBe(2);
  });

  it('an empty emitted set still scopes the delete to §20.2 non-DISMISSED rows', async () => {
    const { repository, recommendation } = prismaOver();

    await repository.withdrawRepeatedFailedActionsExcept([]);

    expect(recommendation.deleteMany.mock.calls[0]?.[0]).toMatchObject({
      where: { category: 'REPEATED_FAILED_ACTION', fingerprint: { notIn: [] } },
    });
  });

  it('pages each category on its own — the default list never sees a §20.2 row', async () => {
    const { repository, recommendation } = prismaOver();

    await repository.listRecommendations(51, 0);
    await repository.listRepeatedFailedActions(51, 0);

    expect(recommendation.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { category: 'DETERMINISTIC_CANDIDATE' },
    });
    expect(recommendation.findMany.mock.calls[1]?.[0]).toMatchObject({
      where: { category: 'REPEATED_FAILED_ACTION' },
    });
  });
});
