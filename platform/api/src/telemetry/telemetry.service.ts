import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  IdSchema,
  INGEST_ERROR_CODES,
  INGEST_LIMITS,
  parseTelemetryEvent,
  type IngestResponse,
  type IngestResult,
  type TelemetryEvent,
} from '@lengentic/shared';
import { entityKindOf, toMergeEvent, type EntityKind } from './event-mapping';
import { mergeEvent, type EntityMergeState } from './merge-rules';
import { TelemetryRepository } from './telemetry.repository';

interface BatchItem {
  readonly index: number;
  readonly event: TelemetryEvent;
}

interface EntityGroup {
  readonly kind: EntityKind;
  readonly entityId: string;
  readonly runId: string;
  readonly items: BatchItem[];
}

/**
 * Best-effort `eventId` extraction for an event rejected before `parseTelemetryEvent` runs
 * (the EVENT_TOO_LARGE check, ADR 0006). Mirrors `platform/shared/schema/parse.ts`'s
 * private `readEventId` — not exported from `@lengentic/shared`'s public surface, so it is
 * reproduced here rather than reached into. `IngestResult.eventId` is `z.string()`, never
 * null, so an unreadable id reports as `''`, the same sentinel `parseTelemetryEvent` uses.
 */
function readEventIdBestEffort(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return '';
  const parsed = IdSchema.safeParse((raw as Record<string, unknown>)['eventId']);
  return parsed.success ? parsed.data : '';
}

/**
 * ADR 0006: the 64 KB cap is measured "on the serialized event" — this project's own
 * enforcement point, since `parseTelemetryEvent` deliberately does not attempt it (the raw
 * wire bytes are gone once the body has been JSON-parsed into `unknown`; this re-serializes
 * to recover an honest byte count).
 */
function serializedByteLength(raw: unknown): number {
  try {
    const json = JSON.stringify(raw);
    return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
  } catch {
    // Circular structures etc. can't have been legal JSON on the wire in the first place;
    // parseTelemetryEvent's own shape checks reject them on the next line.
    return 0;
  }
}

/**
 * Every `eventId` this entity has already recorded, start or completion side. Used for
 * idempotency (§12: "Re-posting a known eventId is a no-op").
 *
 * Exact for the start side (`startEventId` is the sole start-side winner, tracked
 * atomically). For the completion side this also walks `completionFieldOrigins`, not just
 * `completionEventId` — a completion event can win an individual field's provenance
 * (ADR 0007 §3) without becoming the entity's overall `completionEventId`, and that event's
 * `eventId` must still count as "seen" or a repost of it would be misclassified `ACCEPTED`
 * instead of `DUPLICATE`.
 *
 * Known gap, accepted rather than blocking (no dedup ledger table exists — see
 * `docs/decisions/0005-phase-2-wire-contract-gaps.md` decision 1 — and adding one is outside
 * `platform/api/src/**`, this lane's `allowed_paths`): a completion event that wins NEITHER
 * `completionEventId` NOR any field origin (an empty-`fields` event whose `occurredAt` loses
 * every comparison) leaves no trace on the row. Reposting it is still safe — merge-rules.ts
 * is pure, so it resolves identically and never creates a new row or an error — but it would
 * be classified `ACCEPTED` a second time rather than `DUPLICATE`.
 */
function collectKnownEventIds(state: EntityMergeState | undefined): Set<string> {
  const ids = new Set<string>();
  if (!state) return ids;
  if (state.startEventId !== null) ids.add(state.startEventId);
  if (state.completionEventId !== null) ids.add(state.completionEventId);
  for (const origin of Object.values(state.completionFieldOrigins)) ids.add(origin.eventId);
  return ids;
}

@Injectable()
export class TelemetryService {
  constructor(private readonly repository: TelemetryRepository) {}

  /**
   * POST /v1/telemetry/events. §12's whole per-event contract in one pass:
   *
   * 1. Event-level rejection (size, then schema) never fails the batch — every raw event
   *    gets exactly one `IngestResult`, regardless of what happens to its neighbours.
   * 2. Accepted events are grouped by entity (`kind:entityId`) and folded through
   *    `mergeEvent` IN BATCH ORDER, seeded from that entity's persisted state — so two
   *    events for the same entity in one request observe each other, and a duplicate
   *    within a single batch is caught exactly like a duplicate across two requests.
   * 3. Each entity's final state is written once, after its whole group has folded — not
   *    once per event — so a 10-event batch for one Step is one upsert, not ten.
   */
  async ingest(rawEvents: readonly unknown[]): Promise<IngestResponse> {
    const results: IngestResult[] = new Array(rawEvents.length);
    let accepted = 0;
    let duplicate = 0;
    let rejected = 0;
    const groups = new Map<string, EntityGroup>();

    for (let index = 0; index < rawEvents.length; index++) {
      const raw = rawEvents[index];

      if (serializedByteLength(raw) > INGEST_LIMITS.maxEventPayloadBytes) {
        results[index] = {
          eventId: readEventIdBestEffort(raw),
          status: 'REJECTED',
          error: {
            code: INGEST_ERROR_CODES.EVENT_TOO_LARGE,
            message: `event exceeds the maximum size of ${INGEST_LIMITS.maxEventPayloadBytes} bytes`,
          },
        };
        rejected++;
        continue;
      }

      const parsed = parseTelemetryEvent(raw);
      if (!parsed.ok) {
        results[index] = {
          eventId: parsed.eventId,
          status: 'REJECTED',
          error: { code: parsed.code, message: parsed.message },
        };
        rejected++;
        continue;
      }

      const event = parsed.event;
      const kind = entityKindOf(event.type);
      const key = `${kind}:${event.entityId}`;
      let group = groups.get(key);
      if (!group) {
        group = { kind, entityId: event.entityId, runId: event.runId, items: [] };
        groups.set(key, group);
      }
      group.items.push({ index, event });
    }

    // One server clock reading for the whole request — every event this batch accepts was,
    // as far as this process is concerned, received at the same moment.
    const receivedAt = Date.now();

    for (const group of groups.values()) {
      const existing =
        group.kind === 'run'
          ? await this.repository.loadRun(group.entityId)
          : await this.repository.loadStep(group.entityId);

      let state = existing;
      const seen = collectKnownEventIds(existing);

      for (const { index, event } of group.items) {
        if (seen.has(event.eventId)) {
          results[index] = { eventId: event.eventId, status: 'DUPLICATE' };
          duplicate++;
          continue;
        }
        seen.add(event.eventId);
        state = mergeEvent(state, toMergeEvent(event, receivedAt));
        results[index] = { eventId: event.eventId, status: 'ACCEPTED' };
        accepted++;
      }

      if (state !== undefined) {
        if (group.kind === 'run') {
          await this.repository.saveRun(group.entityId, state);
        } else {
          await this.repository.saveStep(group.entityId, group.runId, state);
        }
      }
    }

    return {
      batchId: randomUUID(),
      accepted,
      duplicate,
      rejected,
      results,
    };
  }
}
