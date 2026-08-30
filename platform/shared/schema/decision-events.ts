import { z } from 'zod';

import { IdSchema, MetadataSchema, NameSchema, TimestampSchema } from './primitives';

// §13/§14. The entity's own id is the envelope's `entityId` (§12: "the
// Run/Step/Decision/ModelCall/ToolCall/Error updated") and `runId` is on the envelope too,
// so neither appears in a payload here — the same split run-events.ts and step-events.ts use.

// §14: `outcomeAttestedBy` stays CALLER | UNKNOWN, and an INFERRED value "has no producer
// and would be speculative schema". It is deliberately NOT a wire field: the caller cannot
// choose it. UNKNOWN is the state of a Decision nobody has attested, and the arrival of a
// `decision.outcome_attested` event is itself the evidence that a caller attested — so the
// column is derived at the persistence edge, not transmitted. Putting it on the wire would
// let a caller send `UNKNOWN` alongside an attestation, which is not a statement the domain
// has a meaning for. The stored vocabulary lives in the Prisma enum (p4.entities).
export const DECISION_OUTCOMES = Object.freeze(['SUCCESS', 'FAILURE', 'UNKNOWN'] as const);

export const DecisionOutcomeSchema = z.enum(DECISION_OUTCOMES);

export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

/**
 * `decision.recorded` — a decision point was reached and an option was chosen.
 *
 * Required/optional here follows p4.entities' Prisma model, which records which of its
 * nullable columns are nullable for the *attestation-first* case (a row created by an
 * attestation that arrived before its decision) rather than because a recorded decision may
 * omit them. Those are required on this payload: `stepId` ("Nullable for the attestation-first
 * case ... not because a recorded decision may omit it") and `decisionType` ("Nullable:
 * attestation-first").
 */
export const DecisionRecordedPayloadSchema = z.object({
  stepId: IdSchema,

  /** The recurring decision point being analyzed, e.g. `execution_strategy` (§29). */
  decisionType: NameSchema,

  /**
   * §14 and docs/decisions/0003: caller-supplied, caller-computed. `.nullish()` and not
   * required, because §14 is explicit that a caller may supply none — "the decision is
   * stored but **excluded from aggregation**". Rejecting the event instead would lose the
   * decision entirely; silently defaulting the key is how fake dominance gets manufactured.
   * Excluding it from aggregation is the only answer that loses neither.
   */
  contextKey: NameSchema.nullish(),
  contextKeyVersion: NameSchema.nullish(),

  /**
   * Stored alongside the key so re-normalization stays possible without losing history
   * (§14). Size-capped and redacted client-side per §15 — this schema validates shape, not
   * size; the byte cap is INGEST_LIMITS.maxEventPayloadBytes, measured over the serialized
   * event by the ingest endpoint. §13: never hidden model chain-of-thought.
   */
  rawContext: MetadataSchema.nullish(),

  /**
   * §13 lists both unmarked, so both are required. A recorded decision with no options is
   * not a decision, and one with no selection has not been made yet — neither is a thing
   * this event reports.
   */
  availableOptions: z.array(NameSchema).min(1),
  selectedOption: NameSchema,
});

/**
 * `decision.outcome_attested` — §14's independent, idempotent attestation, keyed on the
 * decision id (the envelope's `entityId`). Deliberately its own event and not a field on
 * `decision.recorded`: outcomes are usually known later, "sometimes after the emitting
 * process has exited".
 *
 * An attestation for an unknown decision id is accepted and stored, not rejected (§14) —
 * that is the API's concern, and nothing in this payload assumes the decision arrived first.
 * Re-attesting the same id is last-write-wins, also the API's concern.
 */
export const DecisionOutcomeAttestedPayloadSchema = z.object({
  outcome: DecisionOutcomeSchema,

  /**
   * §14's `{ observedAt }` — optional there, and `outcomeObservedAt` is nullable in the
   * Prisma model. When absent the persistence edge has the envelope's `occurredAt` to fall
   * back on; inventing a required field the documented SDK signature does not supply would
   * make the contract reject its own caller.
   */
  observedAt: TimestampSchema.nullish(),
});

export type DecisionRecordedPayload = z.infer<typeof DecisionRecordedPayloadSchema>;
export type DecisionOutcomeAttestedPayload = z.infer<typeof DecisionOutcomeAttestedPayloadSchema>;
