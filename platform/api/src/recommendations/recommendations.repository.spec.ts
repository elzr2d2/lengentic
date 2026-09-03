import { describe, expect, it, vi } from 'vitest';

import { RecommendationsRepository } from './recommendations.repository';
import { recommendationFingerprint } from './fingerprint';
import type { RecommendationSighting } from './recommendation-record';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Seam: the exact statement this repository sends Prisma, and the behaviour that statement
 * has under Prisma's own documented semantics.
 *
 * Two kinds of assertion, kept apart on purpose:
 *
 * 1. **Query shape** — what is in `where`, `create` and `update`. This is what catches a
 *    find-then-write rewrite: an implementation that read the row and then chose a branch
 *    would produce the same final state as the upsert while reopening the race §21's
 *    uniqueness constraint exists to close, and a state-only assertion cannot tell them
 *    apart. The Phase 4 wave-4 gate killed `runs.repository.ts`'s `where` clauses with
 *    203/203 tests green for exactly this reason.
 * 2. **Behaviour under a Prisma-semantics fake** — `upsertOver` below implements `upsert` the
 *    way Prisma documents it (match on the unique `where`; insert `create` if absent,
 *    otherwise apply `update`'s keys onto the existing row) and nothing else. Written from
 *    Prisma's contract, not from this repository's implementation, so "a second sighting does
 *    not insert a second row" and "DISMISSED survives re-analysis" are observed rather than
 *    argued.
 *
 * The real client is not exercised here. A round trip against a live schema belongs in
 * `platform/api/test/*.integration.spec.ts`, which is outside this lane's `allowed_paths`.
 */

interface UpsertArgs {
  readonly where: { readonly fingerprint: string };
  readonly create: Record<string, unknown>;
  readonly update: Record<string, unknown>;
}

interface UpdateManyAndReturnArgs {
  readonly where: { readonly id: string };
  readonly data: Record<string, unknown>;
}

const OBSERVED_AT = new Date('2026-09-04T09:00:00.000Z');
const RE_OBSERVED_AT = new Date('2026-09-04T17:30:00.000Z');

const GATES = [
  { id: 'G1_sample_count', status: 'PASS', comparison: '50 >= 30' },
  { id: 'G2_context_diversity', status: 'PASS', comparison: '12 >= 5' },
  { id: 'G3_dominance', status: 'PASS', comparison: '98.0% >= 90.0%' },
  { id: 'G4_outcome_success', status: 'PASS', comparison: '96.0% >= 90.0%' },
  { id: 'G5_outcome_coverage', status: 'PASS', comparison: '94.0% >= 80.0%' },
] as const;

function sighting(overrides: Partial<RecommendationSighting> = {}): RecommendationSighting {
  return {
    category: 'DETERMINISTIC_CANDIDATE',
    analyzerId: 'deterministic-candidate',
    analyzerVersion: '1.0.0',
    groupKey: {
      workflowName: 'demo-workflow',
      workflowVersion: 'a1b2c3d',
      decisionType: 'run_tests_after_code_change',
      contextKeyVersion: 'v1',
    },
    configSnapshot: {
      minSampleCount: 30,
      minDistinctContexts: 5,
      dominanceThreshold: 0.9,
      successThreshold: 0.9,
      coverageThreshold: 0.8,
    },
    sourceWatermark: new Date('2026-09-04T08:59:00.000Z'),
    evidence: {
      sampleCount: 50,
      distinctContextKeyCount: 12,
      optionDistribution: [
        { option: 'YES', count: 49, share: 0.98 },
        { option: 'NO', count: 1, share: 0.02 },
      ],
      dominantOption: 'YES',
      dominancePercentage: 0.98,
      attestedCount: 47,
      outcomeCoverage: 0.94,
      dominantOptionAttestedSuccessRate: 0.96,
      minorityContextConcentration: [
        { contextKey: 'post_refactor_large_diff', count: 1, share: 1 },
      ],
      excluded: { staleRun: 0, missingContextKey: 0 },
      gates: [...GATES],
    },
    counterexamples: [
      {
        decisionId: 'dec-8f2a',
        runId: 'run-8f2a',
        contextKey: 'post_refactor_large_diff',
        selectedOption: 'NO',
        outcome: 'SUCCESS',
      },
    ],
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

/** Every write verb the model has, not only the one the implementation should reach for. */
function verbs(
  upsert: (args: UpsertArgs) => Promise<Record<string, unknown>>,
  updateManyAndReturn: (args: UpdateManyAndReturnArgs) => Promise<Record<string, unknown>[]> = () =>
    Promise.resolve([]),
): {
  prisma: PrismaService;
  recommendation: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    updateManyAndReturn: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
} {
  const recommendation = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    updateManyAndReturn: vi.fn(updateManyAndReturn),
    upsert: vi.fn(upsert),
  };

  return { prisma: { client: { recommendation } } as unknown as PrismaService, recommendation };
}

/**
 * `upsert` as Prisma documents it, over an in-memory table keyed on the unique column named
 * in `where`. No knowledge of which columns this repository happens to send.
 */
function upsertOver(rows: Map<string, Record<string, unknown>>) {
  return (args: UpsertArgs): Promise<Record<string, unknown>> => {
    const existing = rows.get(args.where.fingerprint);

    if (existing === undefined) {
      // Column defaults the database would apply on INSERT, and only on INSERT.
      const created = { status: 'OPEN', statusNote: null, statusChangedAt: null, ...args.create };
      rows.set(args.where.fingerprint, created);
      return Promise.resolve(created);
    }

    const updated = { ...existing, ...args.update };
    rows.set(args.where.fingerprint, updated);
    return Promise.resolve(updated);
  };
}

describe('RecommendationsRepository.recordSighting — the query it sends', () => {
  it('keys the upsert on the fingerprint of the analyzer and the group key, not on an id', async () => {
    const { prisma, recommendation } = verbs(upsertOver(new Map()));
    const write = sighting();

    await new RecommendationsRepository(prisma).recordSighting(write);

    const args = recommendation.upsert.mock.calls[0]?.[0] as UpsertArgs;

    expect(args.where).toStrictEqual({
      fingerprint: recommendationFingerprint({
        analyzerId: write.analyzerId,
        analyzerVersion: write.analyzerVersion,
        groupKey: write.groupKey,
      }),
    });
  });

  it('never reads before it writes — one statement, so two concurrent runs cannot both insert', async () => {
    const { prisma, recommendation } = verbs(upsertOver(new Map()));

    await new RecommendationsRepository(prisma).recordSighting(sighting());

    expect(recommendation.upsert).toHaveBeenCalledTimes(1);
    expect(recommendation.findUnique).not.toHaveBeenCalled();
    expect(recommendation.findFirst).not.toHaveBeenCalled();
    expect(recommendation.create).not.toHaveBeenCalled();
    expect(recommendation.update).not.toHaveBeenCalled();
  });

  it('sends exactly five columns on update — §21s lifecycle is the omissions', async () => {
    const { prisma, recommendation } = verbs(upsertOver(new Map()));

    await new RecommendationsRepository(prisma).recordSighting(sighting());

    const args = recommendation.upsert.mock.calls[0]?.[0] as UpsertArgs;

    expect(Object.keys(args.update).sort()).toStrictEqual([
      'configSnapshot',
      'counterexamples',
      'evidence',
      'lastSeenAt',
      'sourceWatermark',
    ]);

    // Named individually as well as by the list above: each absence is a separate §21 rule,
    // and a reader repairing one should see which rule they are about to break.
    expect(args.update).not.toHaveProperty('status');
    expect(args.update).not.toHaveProperty('firstSeenAt');
    expect(args.update).not.toHaveProperty('statusNote');
    expect(args.update).not.toHaveProperty('statusChangedAt');
    expect(args.update).not.toHaveProperty('id');
  });

  it('creates with firstSeenAt and lastSeenAt both at the run instant, and the group key flattened', async () => {
    const { prisma, recommendation } = verbs(upsertOver(new Map()));

    await new RecommendationsRepository(prisma).recordSighting(sighting());

    const args = recommendation.upsert.mock.calls[0]?.[0] as UpsertArgs;

    expect(args.create.firstSeenAt).toBe(OBSERVED_AT);
    expect(args.create.lastSeenAt).toBe(OBSERVED_AT);
    expect(args.create.workflowName).toBe('demo-workflow');
    expect(args.create.workflowVersion).toBe('a1b2c3d');
    expect(args.create.decisionType).toBe('run_tests_after_code_change');
    expect(args.create.contextKeyVersion).toBe('v1');
    expect(args.create.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('RecommendationsRepository.recordSighting — §21 re-analysis behaviour', () => {
  it('a second sighting of the same group updates the row; it does not insert a duplicate', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const { prisma } = verbs(upsertOver(rows));
    const repository = new RecommendationsRepository(prisma);

    const first = await repository.recordSighting(sighting());
    const second = await repository.recordSighting(
      sighting({
        observedAt: RE_OBSERVED_AT,
        evidence: { ...sighting().evidence, sampleCount: 61, distinctContextKeyCount: 14 },
      }),
    );

    expect(rows.size).toBe(1);
    expect(second.id).toBe(first.id);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.evidence.sampleCount).toBe(61);
    expect(second.lastSeenAt).toStrictEqual(RE_OBSERVED_AT);
    expect(second.firstSeenAt).toStrictEqual(OBSERVED_AT);
  });

  it('a DISMISSED recommendation stays DISMISSED across re-analysis (§21, 5b DoD)', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const { prisma } = verbs(upsertOver(rows));
    const repository = new RecommendationsRepository(prisma);

    await repository.recordSighting(sighting());

    // The human dismisses it, through whatever path — modelled here as the stored state,
    // because what is under test is that re-analysis does not undo it.
    const [fingerprint] = [...rows.keys()];
    const stored = rows.get(fingerprint ?? '');
    rows.set(fingerprint ?? '', {
      ...stored,
      status: 'DISMISSED',
      statusNote: 'known trade-off',
      statusChangedAt: new Date('2026-09-04T12:00:00.000Z'),
    });

    const resighted = await repository.recordSighting(sighting({ observedAt: RE_OBSERVED_AT }));

    expect(resighted.status).toBe('DISMISSED');
    expect(resighted.statusNote).toBe('known trade-off');
    expect(resighted.lastSeenAt).toStrictEqual(RE_OBSERVED_AT);
  });

  it('a new analyzerVersion is a NEW recommendation, not an update (§21)', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const { prisma } = verbs(upsertOver(rows));
    const repository = new RecommendationsRepository(prisma);

    const first = await repository.recordSighting(sighting());
    const second = await repository.recordSighting(sighting({ analyzerVersion: '2.0.0' }));

    expect(rows.size).toBe(2);
    expect(second.id).not.toBe(first.id);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('a new workflowVersion is a NEW recommendation, not an update (§21)', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const { prisma } = verbs(upsertOver(rows));
    const repository = new RecommendationsRepository(prisma);
    const base = sighting();

    await repository.recordSighting(base);
    await repository.recordSighting(
      sighting({ groupKey: { ...base.groupKey, workflowVersion: 'deadbee' } }),
    );

    expect(rows.size).toBe(2);
  });

  it('a new contextKeyVersion is a NEW recommendation, not an update (§21)', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const { prisma } = verbs(upsertOver(rows));
    const repository = new RecommendationsRepository(prisma);
    const base = sighting();

    await repository.recordSighting(base);
    await repository.recordSighting(
      sighting({ groupKey: { ...base.groupKey, contextKeyVersion: 'v2' } }),
    );

    expect(rows.size).toBe(2);
  });

  it('maps the row back out with no Prisma shape attached, counterexamples included', async () => {
    const { prisma } = verbs(upsertOver(new Map()));

    const record = await new RecommendationsRepository(prisma).recordSighting(sighting());

    expect(record.counterexamples).toStrictEqual(sighting().counterexamples);
    expect(record.groupKey).toStrictEqual(sighting().groupKey);
    expect(record.configSnapshot).toStrictEqual(sighting().configSnapshot);
    expect(record.evidence.gates).toHaveLength(5);
    expect(record.status).toBe('OPEN');
    expect(record.statusChangedAt).toBeNull();
  });

  it('refuses a row whose evidence column is unreadable rather than reporting a claim with no evidence', async () => {
    const { prisma } = verbs(() =>
      Promise.resolve({
        id: 'rec-1',
        category: 'DETERMINISTIC_CANDIDATE',
        analyzerId: 'a',
        analyzerVersion: '1',
        workflowName: 'w',
        workflowVersion: 'v',
        decisionType: 'd',
        contextKeyVersion: 'c',
        configSnapshot: sighting().configSnapshot,
        sourceWatermark: OBSERVED_AT,
        fingerprint: 'f',
        evidence: { sampleCount: 'fifty' },
        counterexamples: [],
        firstSeenAt: OBSERVED_AT,
        lastSeenAt: OBSERVED_AT,
        status: 'OPEN',
        statusNote: null,
        statusChangedAt: null,
      }),
    );

    await expect(new RecommendationsRepository(prisma).recordSighting(sighting())).rejects.toThrow(
      /unreadable evidence column/,
    );
  });
});

describe('RecommendationsRepository.setStatus', () => {
  it('updates status, note and changedAt for the named id, and nothing else', async () => {
    const changedAt = new Date('2026-09-04T12:00:00.000Z');
    const { prisma, recommendation } = verbs(upsertOver(new Map()), () => Promise.resolve([]));

    await new RecommendationsRepository(prisma).setStatus(
      'rec-1',
      'DISMISSED',
      'known trade-off',
      changedAt,
    );

    const args = recommendation.updateManyAndReturn.mock.calls[0]?.[0] as UpdateManyAndReturnArgs;

    expect(args.where).toStrictEqual({ id: 'rec-1' });
    expect(args.data).toStrictEqual({
      status: 'DISMISSED',
      statusNote: 'known trade-off',
      statusChangedAt: changedAt,
    });
  });

  it('writes a null note rather than leaving the previous one attached to a new status', async () => {
    const { prisma, recommendation } = verbs(upsertOver(new Map()), () => Promise.resolve([]));

    await new RecommendationsRepository(prisma).setStatus('rec-1', 'OPEN', null, OBSERVED_AT);

    const args = recommendation.updateManyAndReturn.mock.calls[0]?.[0] as UpdateManyAndReturnArgs;

    expect(args.data.statusNote).toBeNull();
  });

  it('reports undefined for an unknown id — no row updated, nothing invented', async () => {
    const { prisma } = verbs(upsertOver(new Map()), () => Promise.resolve([]));

    await expect(
      new RecommendationsRepository(prisma).setStatus('nope', 'DISMISSED', null, OBSERVED_AT),
    ).resolves.toBeUndefined();
  });
});
