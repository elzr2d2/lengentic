// Wire event -> merge-rules event. Pure mapping, no I/O — the seam between the validated
// wire shape (`platform/shared/schema/**`) and the pure merge reducer (`./merge-rules.ts`).
//
// Two decisions live here, both dictated by the two modules on either side of the seam:
//
// - `entityKindOf` decides which table an event belongs to (Run vs Step). §12 identifies
//   the entity by `entityId` alone; the TYPE prefix (`run.` vs `step.`) is the only signal
//   available to route it, since `entityId` itself carries no kind information.
// - `toMergeEvent` splits a completion payload's `status` out of `fields` — merge-rules.ts
//   requires `status` as a distinct top-level input (`MergeEvent.status`) separate from the
//   opaque `fields` bag, because `resolveTerminalStatus` and the per-key `completionFields`
//   fold are governed by different rules (OD-3 vs ADR 0007 §3).
import type { TelemetryEvent, TelemetryEventType } from '@lengentic/shared';
import type { MergeEvent } from './merge-rules';

export type EntityKind = 'run' | 'step';

export function entityKindOf(type: TelemetryEventType): EntityKind {
  return type.startsWith('run.') ? 'run' : 'step';
}

/**
 * `receivedAt` is passed in rather than read from `Date.now()` here so this stays a pure
 * function of its inputs — the caller (`TelemetryService`) captures one `receivedAt` per
 * request and reuses it for every event in the batch.
 */
export function toMergeEvent(event: TelemetryEvent, receivedAt: number): MergeEvent {
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
