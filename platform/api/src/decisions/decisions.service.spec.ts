import { describe, expect, it, vi } from 'vitest';
import type { DecisionOutcome, TelemetryEventOf } from '@lengentic/shared';
import { DecisionsService } from './decisions.service';
import type { DecisionAttestation } from './decision-attestation';
import type { DecisionRecordWrite } from './decision-record';
import type { DecisionsRepository } from './decisions.repository';

/**
 * Seam: the module's public entry — a validated `decision.outcome_attested` envelope in, one
 * attestation handed to the persistence edge out.
 *
 * The repository is a double here on purpose, and it deliberately does NOT emulate the
 * database: it records what it was given and nothing else. What the query does with that is
 * `decisions.repository.spec.ts`'s seam, and a double that reproduced upsert semantics here
 * would be the fake-that-does-the-work pattern the wave-4 gate caught in
 * `runs.service.spec.ts` — where four surviving mutants in `runs.repository.ts` left 203/203
 * green.
 */

const OCCURRED_AT = '2026-08-31T12:00:00.000Z';

function attestationEvent(
  options: {
    decisionId?: string;
    runId?: string;
    outcome?: DecisionOutcome;
    observedAt?: string;
  } = {},
): TelemetryEventOf<'decision.outcome_attested'> {
  return {
    eventId: 'evt-1',
    schemaVersion: '2',
    type: 'decision.outcome_attested',
    entityId: options.decisionId ?? 'dec-1',
    runId: options.runId ?? 'run-9',
    occurredAt: OCCURRED_AT,
    payload: {
      outcome: options.outcome ?? 'SUCCESS',
      ...(options.observedAt === undefined ? {} : { observedAt: options.observedAt }),
    },
  };
}

function fakeRepository(): {
  repository: DecisionsRepository;
  attestOutcome: ReturnType<typeof vi.fn<(input: DecisionAttestation) => Promise<void>>>;
  record: ReturnType<typeof vi.fn<(input: DecisionRecordWrite) => Promise<void>>>;
} {
  const attestOutcome = vi.fn<(input: DecisionAttestation) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const record = vi.fn<(input: DecisionRecordWrite) => Promise<void>>(() => Promise.resolve());
  return {
    repository: { attestOutcome, record } as unknown as DecisionsRepository,
    attestOutcome,
    record,
  };
}

function decisionRecordedEvent(
  options: { decisionId?: string; runId?: string } = {},
): TelemetryEventOf<'decision.recorded'> {
  return {
    eventId: 'evt-1',
    schemaVersion: '2',
    type: 'decision.recorded',
    entityId: options.decisionId ?? 'dec-1',
    runId: options.runId ?? 'run-9',
    occurredAt: '2026-09-02T10:00:00.000Z',
    payload: {
      stepId: 'step-1',
      decisionType: 'execution_strategy',
      availableOptions: ['sequential', 'parallel'],
      selectedOption: 'sequential',
    },
  };
}

describe('DecisionsService.record', () => {
  it('hands the mapped write straight to the repository', async () => {
    const { repository, record } = fakeRepository();

    await new DecisionsService(repository).record(
      decisionRecordedEvent({ decisionId: 'dec-42', runId: 'run-from-elsewhere' }),
    );

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      decisionId: 'dec-42',
      runId: 'run-from-elsewhere',
    });
  });

  it('propagates a persistence failure rather than reporting a recording it did not store', async () => {
    const { repository, record } = fakeRepository();
    record.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(new DecisionsService(repository).record(decisionRecordedEvent())).rejects.toThrow(
      'connection terminated',
    );
  });
});

describe('DecisionsService.attestOutcome', () => {
  it('persists an attestation for a decision the platform has never seen', async () => {
    // §14's cross-process case, and the one the wave-4 validator confirmed the SDK already
    // emits: `client.attestOutcome('decision-never-recorded', 'SUCCESS', { runId })` produces
    // a valid envelope from a process that never recorded the decision. The service must not
    // gate on the decision existing — it has no way to ask, and §14 says the answer would be
    // "store it" either way.
    const { repository, attestOutcome } = fakeRepository();

    await new DecisionsService(repository).attestOutcome(
      attestationEvent({
        decisionId: 'decision-never-recorded',
        runId: 'run-from-another-process',
      }),
    );

    expect(attestOutcome).toHaveBeenCalledTimes(1);
    expect(attestOutcome.mock.calls[0]?.[0]).toStrictEqual({
      decisionId: 'decision-never-recorded',
      runId: 'run-from-another-process',
      outcome: 'SUCCESS',
      outcomeAttestedBy: 'CALLER',
      outcomeObservedAt: new Date(OCCURRED_AT),
    });
  });

  it('passes a second attestation for the same decision straight through', async () => {
    // The wave-4 validator established that the SDK emits both of two attestations for one
    // decisionId — "idempotency is the server's side of the contract". The server's answer is
    // last-write-wins on the row (the upsert), NOT dropping the second event: a service that
    // suppressed it would freeze the first outcome forever, and §14 says the opposite.
    const { repository, attestOutcome } = fakeRepository();
    const service = new DecisionsService(repository);

    await service.attestOutcome(attestationEvent({ outcome: 'SUCCESS' }));
    await service.attestOutcome(
      attestationEvent({ outcome: 'FAILURE', observedAt: '2026-08-31T18:00:00.000Z' }),
    );

    expect(attestOutcome).toHaveBeenCalledTimes(2);
    expect(attestOutcome.mock.calls[1]?.[0]).toStrictEqual({
      decisionId: 'dec-1',
      runId: 'run-9',
      outcome: 'FAILURE',
      outcomeAttestedBy: 'CALLER',
      outcomeObservedAt: new Date('2026-08-31T18:00:00.000Z'),
    });
  });

  it('propagates a persistence failure rather than reporting an attestation it did not store', async () => {
    // An attestation that was dropped on the floor and reported as accepted is the "green
    // that lies" shape: the caller believes the outcome is on record, and every attested
    // success rate computed afterwards is short one observation with nothing to show for it.
    const { repository, attestOutcome } = fakeRepository();
    attestOutcome.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(
      new DecisionsService(repository).attestOutcome(attestationEvent()),
    ).rejects.toThrow('connection terminated');
  });
});
