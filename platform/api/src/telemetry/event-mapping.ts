// Wire event -> merge-rules event. Pure mapping, no I/O — the seam between the validated
// wire shape (`platform/shared/schema/**`) and the pure merge reducer (`./merge-rules.ts`),
// AND the seam `telemetry.service.ts` uses to route the four Phase 4 entity types (Decision,
// ModelCall, ToolCall, Error) to their own writers instead.
//
// Three decisions live here, dictated by the modules on either side of the seam:
//
// - `entityKindOf` decides which table an event belongs to, and (ADR 0014) is now total
//   over the nine-member wire contract — every real type answers a table. `null` remains a
//   legal VALUE of the map (see the comment above `ENTITY_KIND_BY_EVENT_TYPE`), kept for a
//   future type that arrives, like these five did, before its persistence lands.
// - `isMergeableEvent`/`mergeEntityKindOf`/`MergeableEventType` keep the OTHER split —
//   which types `merge-rules.ts` folds — a compile concern rather than a runtime one.
//   Widening that fold to cover Decision/ModelCall/ToolCall/Error would be wrong: none of
//   them has Run/Step's start/completion-pair, out-of-order-arrival shape, and folding them
//   in would give `merge-rules.ts` a second, unrelated reason to change.
// - `toMergeEvent` splits a completion payload's `status` out of `fields` — merge-rules.ts
//   requires `status` as a distinct top-level input (`MergeEvent.status`) separate from the
//   opaque `fields` bag, because `resolveTerminalStatus` and the per-key `completionFields`
//   fold are governed by different rules (OD-3 vs ADR 0007 §3).
import type { TelemetryEvent, TelemetryEventOf, TelemetryEventType } from '@lengentic/shared';
import type { MergeEvent } from './merge-rules';

/** Every table a wire event can land in. */
export type EntityKind = 'run' | 'step' | 'decision' | 'model_call' | 'tool_call' | 'error';

/**
 * The event types the merge fold understands. Naming them as a type — rather than letting
 * `toMergeEvent` take the whole nine-member union and switch — is what makes the Phase 4
 * types a *compile* concern rather than a runtime one: `toMergeEvent` cannot be handed a
 * `decision.recorded` at all.
 */
export type MergeableEventType =
  'run.started' | 'run.completed' | 'step.started' | 'step.completed';

export type MergeableTelemetryEvent = TelemetryEventOf<MergeableEventType>;

/** The subset of `EntityKind` the merge fold actually persists — `run` and `step` only. */
export type MergeableEntityKind = Extract<EntityKind, 'run' | 'step'>;

/**
 * Which table each wire type ultimately lands in.
 *
 * This was `type.startsWith('run.') ? 'run' : 'step'` through Phase 2, which was correct
 * only while the union held exactly four members. Phase 4 widened it to nine, and that
 * expression answered `'step'` for all five new ones — a decision id written into the Step
 * table, with every gate green. `satisfies Readonly<Record<TelemetryEventType, ...>>` is the
 * mechanism `registry.ts` and `TELEMETRY_EVENT_TYPE_MIN_SCHEMA_VERSION` already use: a tenth
 * event type is a compile error here, not a silent default.
 *
 * `p4.entity-ingest` (ADR 0014) is what makes this table total: `decision.recorded` and
 * `decision.outcome_attested` both answer `'decision'` (§14 — one Decision row, written by
 * two independent event types), and `model_call.recorded` / `tool_call.recorded` /
 * `error.recorded` answer their own single-event table each. `null` stays a legal VALUE
 * here, not a dead one — ADR 0014's Consequences are explicit that `EVENT_TYPE_NOT_INGESTIBLE`
 * "stays exercised": a future type that arrives before its persistence does (as these five
 * did) is mapped `null` exactly the way they were, and `telemetry.service.ts` still turns
 * that into an event-level rejection rather than routing it anywhere. See the note on that
 * code in `platform/shared/schema/ingest.ts`.
 */
const ENTITY_KIND_BY_EVENT_TYPE = Object.freeze({
  'run.started': 'run',
  'run.completed': 'run',
  'step.started': 'step',
  'step.completed': 'step',
  'decision.recorded': 'decision',
  'decision.outcome_attested': 'decision',
  'model_call.recorded': 'model_call',
  'tool_call.recorded': 'tool_call',
  'error.recorded': 'error',
} as const) satisfies Readonly<Record<TelemetryEventType, EntityKind | null>>;

/** The table `type` lands in, or `null` for a legal wire type this server cannot store yet. */
export function entityKindOf(type: TelemetryEventType): EntityKind | null {
  return ENTITY_KIND_BY_EVENT_TYPE[type];
}

/**
 * The same answer as `entityKindOf`, from the same table, for an event already narrowed to
 * one the fold accepts — so the caller does not have to re-handle a `null` it has already
 * excluded, and no second table can drift from the first.
 */
export function mergeEntityKindOf(event: MergeableTelemetryEvent): MergeableEntityKind {
  return ENTITY_KIND_BY_EVENT_TYPE[event.type];
}

/**
 * Narrows an event to one the merge fold accepts. Derived from the same table as
 * `entityKindOf`, so the two can never disagree about a given type.
 *
 * Checks for `'run'` or `'step'` specifically, NOT "non-null" — ADR 0014 made the table
 * total, so `null` stopped being the signal "not mergeable" the moment `'decision'` etc.
 * became legal, non-null values that are still not `'run'`/`'step'`. A `!== null` check here
 * would answer `true` for every Phase 4 type today, routing them into the Run/Step fold
 * `toMergeEvent` cannot handle — exactly the class of regression this file exists to prevent.
 */
export function isMergeableEvent(event: TelemetryEvent): event is MergeableTelemetryEvent {
  const kind = ENTITY_KIND_BY_EVENT_TYPE[event.type];
  return kind === 'run' || kind === 'step';
}

/**
 * `receivedAt` is passed in rather than read from `Date.now()` here so this stays a pure
 * function of its inputs — the caller (`TelemetryService`) captures one `receivedAt` per
 * request and reuses it for every event in the batch.
 */
export function toMergeEvent(event: MergeableTelemetryEvent, receivedAt: number): MergeEvent {
  switch (event.type) {
    case 'run.started':
    case 'step.started':
      return {
        eventId: event.eventId,
        entityId: event.entityId,
        occurredAt: event.occurredAt,
        receivedAt,
        kind: 'start',
        fields: { ...event.payload },
      };
    case 'run.completed':
    case 'step.completed': {
      const { status, ...fields } = event.payload;
      return {
        eventId: event.eventId,
        entityId: event.entityId,
        occurredAt: event.occurredAt,
        receivedAt,
        kind: 'completion',
        status,
        fields,
      };
    }
  }
}
