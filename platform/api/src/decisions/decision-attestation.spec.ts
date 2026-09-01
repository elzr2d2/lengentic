import { describe, expect, it } from 'vitest';
import type { DecisionOutcome, TelemetryEventOf } from '@lengentic/shared';
import { toDecisionAttestation } from './decision-attestation';

/**
 * Seam: the wire event -> domain translation, called on an envelope rather than through a
 * database. This is the only place two facts §14 states but the wire deliberately does not
 * carry get decided:
 *
 * - `outcomeAttestedBy` is not a wire field at all (`schema/decision-events.ts`: "the
 *   arrival of a `decision.outcome_attested` event is itself the evidence that a caller
 *   attested — so the column is derived at the persistence edge, not transmitted").
 * - `observedAt` is optional on the wire, and the same file names this file's fallback:
 *   "When absent the persistence edge has the envelope's `occurredAt` to fall back on".
 *
 * Both expected values are sourced from §14 and from the wire contract's own notes, not
 * from the function under test (TEST-4).
 */

const OCCURRED_AT = '2026-08-31T12:00:00.000Z';
const OBSERVED_AT = '2026-08-31T09:15:30.000Z';

/**
 * `observedAt` is passed only when the caller of this helper names it, so that "absent" and
 * "explicitly null" stay two distinguishable inputs — `DecisionOutcomeAttestedPayloadSchema`
 * types it `.nullish()`, so both reach this code and both must take the fallback.
 */
function attestationEvent(
  options: {
    decisionId?: string;
    runId?: string;
    occurredAt?: string;
    outcome?: DecisionOutcome;
    observedAt?: string | null;
  } = {},
): TelemetryEventOf<'decision.outcome_attested'> {
  return {
    eventId: 'evt-1',
    schemaVersion: '2',
    type: 'decision.outcome_attested',
    entityId: options.decisionId ?? 'dec-1',
    runId: options.runId ?? 'run-1',
    occurredAt: options.occurredAt ?? OCCURRED_AT,
    payload: {
      outcome: options.outcome ?? 'SUCCESS',
      ...('observedAt' in options ? { observedAt: options.observedAt } : {}),
    },
  };
}

describe('toDecisionAttestation', () => {
  it('keys the attestation on the envelope entityId, which is the decision id', () => {
    // §14: attestation is "an independent, idempotent telemetry event keyed on `decisionId`",
    // and §12 identifies the entity an event updates by `entityId`. Nothing else in the
    // envelope or the payload names the decision.
    const attestation = toDecisionAttestation(attestationEvent({ decisionId: 'dec-42' }));

    expect(attestation.decisionId).toBe('dec-42');
  });

  it('takes runId from the envelope, so no live Run or Step handle is needed', () => {
    // The cross-process case: `telemetry.attestOutcome(decisionId, 'SUCCESS', { runId })`
    // from "any process, hours later". The envelope's `runId` is the whole correlation —
    // this function never reads a Step, a prior Decision, or anything else.
    const attestation = toDecisionAttestation(attestationEvent({ runId: 'run-from-elsewhere' }));

    expect(attestation.runId).toBe('run-from-elsewhere');
  });

  it('derives outcomeAttestedBy as CALLER, which the wire cannot say', () => {
    // §14: `outcomeAttestedBy` stays CALLER | UNKNOWN, and UNKNOWN is the state of a decision
    // nobody has attested. An attestation event exists precisely because a caller attested,
    // so CALLER is the only value this branch can produce — and it is why every surface says
    // "attested success rate" rather than "measured".
    expect(toDecisionAttestation(attestationEvent()).outcomeAttestedBy).toBe('CALLER');
  });

  it('carries the attested outcome across verbatim, UNKNOWN included', () => {
    // UNKNOWN is a legal wire outcome (DECISION_OUTCOMES). A caller that attests "I looked
    // and I still do not know" is making a statement, and collapsing it to SUCCESS or
    // dropping the event would manufacture or delete evidence.
    expect(toDecisionAttestation(attestationEvent({ outcome: 'FAILURE' })).outcome).toBe('FAILURE');
    expect(toDecisionAttestation(attestationEvent({ outcome: 'UNKNOWN' })).outcome).toBe('UNKNOWN');
  });

  it('uses the caller-supplied observedAt when there is one', () => {
    // §14's `telemetry.attestOutcome(decisionId, 'SUCCESS', { observedAt })`. The outcome was
    // observed hours before the event was emitted; the caller's instant is the real one.
    expect(toDecisionAttestation(attestationEvent({ observedAt: OBSERVED_AT })).outcomeObservedAt) //
      .toStrictEqual(new Date(OBSERVED_AT));
  });

  it('falls back to the envelope occurredAt when observedAt is absent', () => {
    // `decision-events.ts`, on why `observedAt` is `.nullish()`: "When absent the persistence
    // edge has the envelope's `occurredAt` to fall back on; inventing a required field the
    // documented SDK signature does not supply would make the contract reject its own
    // caller." This function IS that persistence edge.
    expect(toDecisionAttestation(attestationEvent()).outcomeObservedAt).toStrictEqual(
      new Date(OCCURRED_AT),
    );
  });

  it('falls back to occurredAt for an explicitly null observedAt too', () => {
    // `.nullish()` admits both. Treating `null` differently from absent would make the
    // stored instant depend on how a caller spelled "I did not record one".
    expect(
      toDecisionAttestation(attestationEvent({ observedAt: null })).outcomeObservedAt,
    ).toStrictEqual(new Date(OCCURRED_AT));
  });
});
