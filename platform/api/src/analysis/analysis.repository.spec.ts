import { describe, expect, it, vi } from 'vitest';

import { AnalysisRepository, toAnalysisDecisionSource } from './analysis.repository';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Seam: the persistence edge (`toAnalysisDecisionSource`) and the exact two statements
 * `listDecisionsForAnalysis` sends Prisma.
 *
 * Two kinds of assertion, kept apart the way `recommendations.repository.spec.ts` keeps them:
 *
 * 1. **Query shape** — the `orderBy`, and the fact that the second statement is keyed on the
 *    run ids the first returned. `analysis.repository.ts:42-53` claims two analysis runs over
 *    an unchanged database read the same rows in the same sequence; that claim is a total
 *    order in an `orderBy`, and nothing else in the repository can hold it.
 * 2. **The edge** — a `Decision` row plus its `Run`'s columns become an
 *    `AnalysisDecisionSource`. The two fallbacks for a decision whose run row has not arrived
 *    are the interesting part: they decide whether that row is treated as live or stale, and
 *    a run nobody has heard from in a day producing a CANDIDATE is exactly the false positive
 *    the product exists to refuse.
 *
 * The real client is not exercised here — a round trip against a live schema is
 * `platform/api/test/analysis.integration.spec.ts`.
 */

const CREATED_AT = new Date('2026-09-04T10:00:00.000Z');
const LAST_EVENT_AT = new Date('2026-09-04T11:00:00.000Z');

function decisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dec-1',
    runId: 'run-1',
    decisionType: 'run_tests_after_code_change',
    contextKey: 'post_refactor_large_diff',
    contextKeyVersion: 'v1',
    availableOptions: ['YES', 'NO'],
    selectedOption: 'YES',
    outcome: 'SUCCESS' as const,
    outcomeAttestedBy: 'CALLER' as const,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    workflowName: 'demo-workflow',
    workflowVersion: 'a1b2c3d',
    status: 'COMPLETED' as const,
    lastEventAt: LAST_EVENT_AT,
    ...overrides,
  };
}

interface FindManyArgs {
  readonly select?: Record<string, boolean>;
  readonly orderBy?: readonly Record<string, string>[];
  readonly where?: { readonly id?: { readonly in: readonly string[] } };
}

function prismaOver(
  decisions: readonly Record<string, unknown>[],
  runs: readonly Record<string, unknown>[],
): {
  prisma: PrismaService;
  decisionFindMany: ReturnType<typeof vi.fn>;
  runFindMany: ReturnType<typeof vi.fn>;
} {
  const decisionFindMany = vi.fn(() => Promise.resolve([...decisions]));
  const runFindMany = vi.fn(() => Promise.resolve([...runs]));

  return {
    prisma: {
      client: { decision: { findMany: decisionFindMany }, run: { findMany: runFindMany } },
    } as unknown as PrismaService,
    decisionFindMany,
    runFindMany,
  };
}

describe('toAnalysisDecisionSource — the persistence edge', () => {
  it('joins a decision to its run without letting a Prisma row across', () => {
    expect(toAnalysisDecisionSource(decisionRow(), runRow())).toStrictEqual({
      decisionId: 'dec-1',
      runId: 'run-1',
      runStatus: 'COMPLETED',
      runLastEventAt: LAST_EVENT_AT,
      workflowName: 'demo-workflow',
      workflowVersion: 'a1b2c3d',
      decisionType: 'run_tests_after_code_change',
      contextKey: 'post_refactor_large_diff',
      contextKeyVersion: 'v1',
      availableOptions: ['YES', 'NO'],
      selectedOption: 'YES',
      outcome: 'SUCCESS',
      outcomeAttestedBy: 'CALLER',
      createdAt: CREATED_AT,
    });
  });

  it('carries the run STORED status through, whatever it is — STALE is derived later, never here', () => {
    // A repository that substituted a status of its own would make §39's rule uncomputable:
    // the rule reads `storedStatus === 'RUNNING'`, so a row that arrived RUNNING and left
    // COMPLETED can never be found stale, and a run idle for a day would produce a CANDIDATE.
    expect(toAnalysisDecisionSource(decisionRow(), runRow({ status: 'RUNNING' })).runStatus).toBe(
      'RUNNING',
    );
    expect(toAnalysisDecisionSource(decisionRow(), runRow({ status: 'FAILED' })).runStatus).toBe(
      'FAILED',
    );
    expect(toAnalysisDecisionSource(decisionRow(), runRow({ status: 'COMPLETED' })).runStatus).toBe(
      'COMPLETED',
    );
  });

  it('treats a decision whose run row has not arrived as RUNNING and idle since its own createdAt', () => {
    // ADR 0005 decision 4: STALE is "RUNNING and idle past the threshold", and a run with no
    // row has no `lastEventAt` to be idle since. The row is excluded anyway — `workflowName`
    // is null below, so it has no §18 group key — and this keeps that exclusion attributable
    // to the missing workflow rather than to a fabricated idle time.
    const joined = toAnalysisDecisionSource(decisionRow(), undefined);

    expect(joined.runStatus).toBe('RUNNING');
    expect(joined.runLastEventAt).toStrictEqual(CREATED_AT);
    expect(joined.workflowName).toBeNull();
    expect(joined.workflowVersion).toBeNull();
  });

  it('degrades an unreadable availableOptions to [] — a column §18 never reads', () => {
    // Safe HERE specifically: dominance is computed over `selectedOption`, so this value
    // cannot change a gate, a distribution or a counterexample.
    expect(
      toAnalysisDecisionSource(decisionRow({ availableOptions: 'not-an-array' }), runRow())
        .availableOptions,
    ).toStrictEqual([]);
    expect(
      toAnalysisDecisionSource(decisionRow({ availableOptions: null }), runRow()).availableOptions,
    ).toStrictEqual([]);
  });
});

describe('AnalysisRepository.listDecisionsForAnalysis — the statements it sends', () => {
  it('asks for a TOTAL order: oldest first, tie-broken on id', async () => {
    // `createdAt` is `@default(now())` — one reading per transaction — so a batch that wrote
    // three decisions gives all three the same value. Without the `id` tie-break Postgres is
    // free to order them differently on each read, and the file's own claim that two runs over
    // an unchanged database read the same sequence is false.
    const { prisma, decisionFindMany } = prismaOver([], []);

    await new AnalysisRepository(prisma).listDecisionsForAnalysis();

    const args = decisionFindMany.mock.calls[0]?.[0] as FindManyArgs;

    expect(args.orderBy).toStrictEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  });

  it('never selects rawContext — §15 large Json column no gate reads', async () => {
    const { prisma, decisionFindMany } = prismaOver([], []);

    await new AnalysisRepository(prisma).listDecisionsForAnalysis();

    const args = decisionFindMany.mock.calls[0]?.[0] as FindManyArgs;

    expect(Object.keys(args.select ?? {})).not.toContain('rawContext');
    expect(Object.keys(args.select ?? {})).toContain('createdAt');
  });

  it('reads the runs of the decisions it found, deduplicated, and nothing else', async () => {
    const { prisma, runFindMany } = prismaOver(
      [
        decisionRow({ id: 'dec-1', runId: 'run-1' }),
        decisionRow({ id: 'dec-2', runId: 'run-2' }),
        decisionRow({ id: 'dec-3', runId: 'run-1' }),
      ],
      [runRow({ id: 'run-1' }), runRow({ id: 'run-2' })],
    );

    await new AnalysisRepository(prisma).listDecisionsForAnalysis();

    const args = runFindMany.mock.calls[0]?.[0] as FindManyArgs;

    expect(args.where?.id?.in).toStrictEqual(['run-1', 'run-2']);
  });

  it('joins in memory, so a decision whose run row is missing survives the read', async () => {
    // Not an inner join: a decision event may legitimately arrive before its run's start
    // event, and vanishing it would delete history rather than exclude it.
    const { prisma } = prismaOver(
      [
        decisionRow({ id: 'dec-1', runId: 'run-1' }),
        decisionRow({ id: 'dec-2', runId: 'run-gone' }),
      ],
      [runRow({ id: 'run-1' })],
    );

    const sources = await new AnalysisRepository(prisma).listDecisionsForAnalysis();

    expect(sources.map((s) => s.decisionId)).toStrictEqual(['dec-1', 'dec-2']);
    expect(sources[0]?.workflowName).toBe('demo-workflow');
    expect(sources[1]?.workflowName).toBeNull();
  });

  it('returns the rows in the order the query returned them', async () => {
    const { prisma } = prismaOver(
      [decisionRow({ id: 'dec-a' }), decisionRow({ id: 'dec-b' }), decisionRow({ id: 'dec-c' })],
      [runRow()],
    );

    const sources = await new AnalysisRepository(prisma).listDecisionsForAnalysis();

    expect(sources.map((s) => s.decisionId)).toStrictEqual(['dec-a', 'dec-b', 'dec-c']);
  });

  it('reports an empty database as no rows, and asks for no runs', async () => {
    const { prisma, runFindMany } = prismaOver([], []);

    await expect(new AnalysisRepository(prisma).listDecisionsForAnalysis()).resolves.toStrictEqual(
      [],
    );

    const args = runFindMany.mock.calls[0]?.[0] as FindManyArgs;

    expect(args.where?.id?.in).toStrictEqual([]);
  });
});
