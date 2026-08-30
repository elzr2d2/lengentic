// Wire event -> merge-rules event. Pure mapping, no I/O — the seam between the validated
// wire shape (`platform/shared/schema/**`) and the pure merge reducer (`./merge-rules.ts`).
//
// Two decisions live here, both dictated by the two modules on either side of the seam:
//
// - `entityKindOf` decides which table an event belongs to (Run vs Step), and returns
//   `null` for the event types this server cannot yet store at all. §12 identifies the
//   entity by `entityId` alone, so the TYPE is the only signal available to route it.
// - `toMergeEvent` splits a completion payload's `status` out of `fields` — merge-rules.ts
//   requires `status` as a distinct top-level input (`MergeEvent.status`) separate from the
//   opaque `fields` bag, because `resolveTerminalStatus` and the per-key `completionFields`
//   fold are governed by different rules (OD-3 vs ADR 0007 §3).
import type { TelemetryEvent, TelemetryEventOf, TelemetryEventType } from '@lengentic/shared';
import type { MergeEvent } from './merge-rules';

export type EntityKind = 'run' | 'step';

/**
 * The event types the merge fold understands. Naming them as a type — rather than letting
 * `toMergeEvent` take the whole nine-member union and switch — is what makes the Phase 4
 * types a *compile* concern rather than a runtime one: `toMergeEvent` cannot be handed a
 * `decision.recorded` at all.
 */
export type MergeableEventType =
  'run.started' | 'run.completed' | 'step.started' | 'step.completed';

export type MergeableTelemetryEvent = TelemetryEventOf<MergeableEventType>;

/**
 * Which entity table each wire type folds into, or `null` for "this server has no
 * persistence for it yet".
 *
 * This was `type.startsWith('run.') ? 'run' : 'step'` through Phase 2, which was correct
 * only while the union held exactly four members. Phase 4 widened it to nine, and that
 * expression answers `'step'` for all five new ones — a decision id written into the Step
 * table, with every gate green. `satisfies Readonly<Record<TelemetryEventType, ...>>` is the
 * mechanism `registry.ts` and `TELEMETRY_EVENT_TYPE_MIN_SCHEMA_VERSION` already use: a tenth
 * event type is a compile error here, not a silent default.
 *
 * `null` is not a shrug. The five Phase 4 types are legal wire events (`schemaVersion` '2',
 * ADR 0005 decision 3) whose Decision / ModelCall / ToolCall / Error rows have no ingest
 * path yet — `merge-rules.ts` folds Run and Step lifecycle state and nothing else. The
 * service turns `null` into an `EVENT_TYPE_NOT_INGESTIBLE` event-level rejection, which is
 * the only one of the three available answers that does not report success for an event
 * nothing stored. See the note on that code in `platform/shared/schema/ingest.ts`.
 */
const ENTITY_KIND_BY_EVENT_TYPE = Object.freeze({
  'run.started': 'run',
  'run.completed': 'run',
  'step.started': 'step',
  'step.completed': 'step',
  'decision.recorded': null,
  'decision.outcome_attested': null,
  'model_call.recorded': null,
  'tool_call.recorded': null,
  'error.recorded': null,
} as const) satisfies Readonly<Record<TelemetryEventType, EntityKind | null>>;

/** The entity table `type` folds into, or `null` when this server cannot store it yet. */
export function entityKindOf(type: TelemetryEventType): EntityKind | null {
  return ENTITY_KIND_BY_EVENT_TYPE[type];
}

/**
 * The same answer as `entityKindOf`, from the same table, for an event already narrowed to
 * one the fold accepts — so the caller does not have to re-handle a `null` it has already
 * excluded, and no second table can drift from the first.
 */
export function mergeEntityKindOf(event: MergeableTelemetryEvent): EntityKind {
  return ENTITY_KIND_BY_EVENT_TYPE[event.type];
}

/**
 * Narrows an event to one the merge fold accepts. Derived from the same table as
 * `entityKindOf`, so the two can never disagree about a given type.
 */
export function isMergeableEvent(event: TelemetryEvent): event is MergeableTelemetryEvent {
  return ENTITY_KIND_BY_EVENT_TYPE[event.type] !== null;
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
