import { describe, expect, it, vi } from 'vitest';
import { DecisionsRepository } from './decisions.repository';
import type { DecisionAttestation } from './decision-attestation';
import type { DecisionRecordWrite } from './decision-record';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Seam: the exact query this repository sends Prisma for §14's attestation — not what a
 * stand-in for Prisma would do with it.
 *
 * That distinction is the whole point of testing here. The Phase 4 wave-4 gate killed
 * `runs.repository.ts`'s `where: { runId }` clauses and 203/203 tests stayed green, because
 * the only tests that exercised those methods went through a fake repository that performed
 * the filtering itself — nothing in the suite ever looked at the query. Every assertion
 * below reads the arguments handed to `decision.upsert`, so deleting or re-keying the
 * `where`, or widening `update`, turns one of them red.
 *
 * The real client is not exercised here; a round trip against a live schema belongs to
 * `test/*.integration.spec.ts`, which is outside this lane's `allowed_paths`.
 */

/** The one shape these tests inspect from an `upsert` call. */
interface DecisionUpsertArgs {
  readonly where: { readonly id: string };
  readonly create: Record<string, unknown>;
  readonly update: Record<string, unknown>;
}

function fakePrismaService(): {
  prisma: PrismaService;
  decision: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn<(args: DecisionUpsertArgs) => Promise<void>>>;
  };
} {
  // Every write verb the model has, not only the one the implementation should reach for.
  // A `findUnique`-then-`create`/`update` implementation would satisfy an assertion about
  // the final state while reintroducing exactly the read-modify-write race the upsert
  // avoids; giving those doubles a home here is what lets the tests below say it did not
  // happen.
  const decision = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn<(args: DecisionUpsertArgs) => Promise<void>>(() => Promise.resolve()),
  };
  const prisma = { client: { decision } } as unknown as PrismaService;
  return { prisma, decision };
}

const OBSERVED_AT = new Date('2026-08-31T09:15:30.000Z');

function recordWrite(overrides: Partial<DecisionRecordWrite> = {}): DecisionRecordWrite {
  return {
    decisionId: 'dec-1',
    runId: 'run-9',
    stepId: 'step-1',
    decisionType: 'execution_strategy',
    contextKey: null,
    contextKeyVersion: null,
    rawContext: null,
    availableOptions: ['sequential', 'parallel'],
    selectedOption: 'sequential',
    ...overrides,
  };
}

describe('DecisionsRepository.record', () => {
  it('keys the write on the decision id and on nothing else', async () => {
    const { prisma, decision } = fakePrismaService();

    await new DecisionsRepository(prisma).record(recordWrite({ decisionId: 'dec-42' }));

    expect(decision.upsert.mock.calls[0]?.[0].where).toStrictEqual({ id: 'dec-42' });
  });

  it('creates a full recording-side row, with the outcome columns left for their own default', async () => {
    const { prisma, decision } = fakePrismaService();

    await new DecisionsRepository(prisma).record(recordWrite());

    expect(decision.upsert.mock.calls[0]?.[0].create).toStrictEqual({
      id: 'dec-1',
      runId: 'run-9',
      stepId: 'step-1',
      decisionType: 'execution_strategy',
      contextKey: null,
      contextKeyVersion: null,
      rawContext: null,
      availableOptions: ['sequential', 'parallel'],
      selectedOption: 'sequential',
    });
    expect(decision.upsert.mock.calls[0]?.[0].create).not.toHaveProperty('outcome');
    expect(decision.upsert.mock.calls[0]?.[0].create).not.toHaveProperty('outcomeAttestedBy');
    expect(decision.upsert.mock.calls[0]?.[0].create).not.toHaveProperty('outcomeObservedAt');
  });

  it('updates the same recording-side columns, and never the three attestation columns', async () => {
    // An attestation-first row (outcome already set) must not be blanked by a later
    // decision.recorded event — the update branch never names outcome/outcomeAttestedBy/
    // outcomeObservedAt at all, so Prisma cannot touch them.
    const { prisma, decision } = fakePrismaService();

    await new DecisionsRepository(prisma).record(
      recordWrite({ contextKey: 'risk=low', contextKeyVersion: 'v1' }),
    );

    expect(decision.upsert.mock.calls[0]?.[0].update).toStrictEqual({
      runId: 'run-9',
      stepId: 'step-1',
      decisionType: 'execution_strategy',
      contextKey: 'risk=low',
      contextKeyVersion: 'v1',
      rawContext: null,
      availableOptions: ['sequential', 'parallel'],
      selectedOption: 'sequential',
    });
  });

  it('writes in one statement, with no read of the decision first', async () => {
    const { prisma, decision } = fakePrismaService();

    await new DecisionsRepository(prisma).record(recordWrite());

    expect(decision.upsert).toHaveBeenCalledTimes(1);
    expect(decision.findUnique).not.toHaveBeenCalled();
    expect(decision.findFirst).not.toHaveBeenCalled();
    expect(decision.create).not.toHaveBeenCalled();
    expect(decision.update).not.toHaveBeenCalled();
  });
});

function attestation(overrides: Partial<DecisionAttestation> = {}): DecisionAttestation {
  return {
    decisionId: 'dec-1',
    // Deliberately not equal to `decisionId`, and not equal to any other literal in this
    // file: an implementation that keyed the upsert on the wrong id would still find a
    // string to key it on, and the assertions have to be able to tell which one.
    runId: 'run-9',
    outcome: 'SUCCESS',
    outcomeAttestedBy: 'CALLER',
    outcomeObservedAt: OBSERVED_AT,
    ...overrides,
  };
}

describe('DecisionsRepository.attestOutcome', () => {
  it('keys the write on the decision id and on nothing else', async () => {
    // §14: "an independent, idempotent telemetry event keyed on `decisionId`". The key is
    // what makes two attestations from two processes converge on one row, and it is why the
    // second one does not need to know anything the first one knew.
    const { prisma, decision } = fakePrismaService();

    await new DecisionsRepository(prisma).attestOutcome(attestation({ decisionId: 'dec-42' }));

    expect(decision.upsert.mock.calls[0]?.[0].where).toStrictEqual({ id: 'dec-42' });
  });

  it('stores an attestation for an unknown decision id instead of rejecting it', async () => {
    // §14: "An attestation for an **unknown** `decisionId` is accepted and stored, not
    // rejected; decisions and attestations may arrive out of order like any other event
    // pair." The `create` branch IS that case — it is reached exactly when no Decision row
    // exists — so the row it writes is the attestation-first row schema.prisma describes:
    // "an id, a runId (envelope-level, always present), the outcome columns — and nothing
    // else."
    const { prisma, decision } = fakePrismaService();

    await new DecisionsRepository(prisma).attestOutcome(attestation());

    expect(decision.upsert.mock.calls[0]?.[0].create).toStrictEqual({
      id: 'dec-1',
      runId: 'run-9',
      outcome: 'SUCCESS',
      outcomeAttestedBy: 'CALLER',
      outcomeObservedAt: OBSERVED_AT,
    });
  });

  it('overwrites exactly the three columns §14 names, and no others', async () => {
    // §14: "Re-attesting the same `decisionId` overwrites `outcome`, `outcomeAttestedBy`,
    // and `outcomeObservedAt` — last write wins."
    //
    // Exactly those three, which is the assertion with teeth. `update` reusing `create`'s
    // column bag — the shape `telemetry.repository.ts`'s `saveRun`/`saveStep` use, and the
    // obvious thing to write here — would put `runId` in this branch, so a late attestation
    // carrying a stale or wrong `runId` would silently re-home a decision that a
    // `decision.recorded` event had already placed. `stepId`, `decisionType`, `contextKey`
    // and `selectedOption` are absent for the same reason: an attestation carries none of
    // them, and writing them would blank the recorded decision.
    const { prisma, decision } = fakePrismaService();

    await new DecisionsRepository(prisma).attestOutcome(
      attestation({ outcome: 'FAILURE', outcomeAttestedBy: 'CALLER' }),
    );

    expect(decision.upsert.mock.calls[0]?.[0].update).toStrictEqual({
      outcome: 'FAILURE',
      outcomeAttestedBy: 'CALLER',
      outcomeObservedAt: OBSERVED_AT,
    });
  });

  it('writes in one statement, with no read of the decision first', async () => {
    // Idempotency by construction rather than by branching on a prior read. A
    // find-then-create-or-update implementation would produce the same row in a quiet test
    // and lose a race in production: two concurrent first attestations for one decisionId
    // both see no row, and both insert. A single upsert has no window between the two.
    const { prisma, decision } = fakePrismaService();

    await new DecisionsRepository(prisma).attestOutcome(attestation());

    expect(decision.upsert).toHaveBeenCalledTimes(1);
    expect(decision.findUnique).not.toHaveBeenCalled();
    expect(decision.findFirst).not.toHaveBeenCalled();
    expect(decision.create).not.toHaveBeenCalled();
    expect(decision.update).not.toHaveBeenCalled();
  });

  it('sends a second attestation for the same decision as its own write', async () => {
    // The re-attestation path end to end at this seam: the same key, the later values. The
    // repository must not suppress, coalesce or de-duplicate the second one — "last write
    // wins" requires the last write to actually happen. Event-level replay (the same
    // `eventId` twice) is the ADR 0005 ledger's job at ingest, not this method's.
    const { prisma, decision } = fakePrismaService();
    const repository = new DecisionsRepository(prisma);
    const later = new Date('2026-08-31T18:00:00.000Z');

    await repository.attestOutcome(attestation({ outcome: 'SUCCESS' }));
    await repository.attestOutcome(attestation({ outcome: 'FAILURE', outcomeObservedAt: later }));

    expect(decision.upsert).toHaveBeenCalledTimes(2);
    expect(decision.upsert.mock.calls[1]?.[0].where).toStrictEqual({ id: 'dec-1' });
    expect(decision.upsert.mock.calls[1]?.[0].update).toStrictEqual({
      outcome: 'FAILURE',
      outcomeAttestedBy: 'CALLER',
      outcomeObservedAt: later,
    });
  });
});
