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
import { containsUnsafeUnicode } from './wire-sanitize';

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
 * NOT exact for the start side (tester-corrected, 2026-08-19 — this comment previously
 * claimed it was). `startEventId` is the sole persisted start-side winner: only the ONE
 * start event that currently wins the first-writer-wins occurredAt contest is remembered.
 * Any OTHER start event this entity has ever seen — one that loses that contest, whether
 * because a genuinely earlier event already exists or because of the ADR-0007-mirrored
 * eventId tie-break — leaves no trace anywhere on the row and is NOT in this set. Reposting
 * such an event is still safe (merge-rules.ts is pure and entities are upserted by
 * entityId, so it can never create a second row or error) but is misclassified `ACCEPTED`
 * a second time instead of `DUPLICATE`. Unlike the completion-side gap below, this is not a
 * narrow edge case — it is every losing start event, which closing for real needs a
 * persisted per-start-event (or per-start-field) ledger schema.prisma does not have today
 * (only `startEventId`, one winner for the whole entity — contrast `completionFieldOrigins`,
 * which gives the completion side partial multi-winner tracking). Adding that column is a
 * schema.prisma change, outside `platform/api/src/**`, this lane's `allowed_paths`.
 *
 * For the completion side this also walks `completionFieldOrigins`, not just
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
   * 1. Event-level rejection (size, then schema, then wire-safety) never fails the batch —
   *    every raw event gets exactly one `IngestResult`, regardless of what happens to its
   *    neighbours.
   * 2. Accepted events are grouped by entity (`kind:entityId`).
   * 3. Each group is folded and saved as ONE atomic unit via
   *    `TelemetryRepository.withEntityLock` (F1 fix, tester regression 2026-08-19): the
   *    load, the `mergeEvent` fold IN BATCH ORDER, and the save all happen inside a single
   *    Postgres transaction guarded by an advisory lock on that entity, so a concurrent
   *    request touching the same `entityId` cannot interleave its own read-modify-write and
   *    silently discard this one's contribution. Within the fold, an entity's persisted
   *    state seeds `seen`/`state` — so two events for the same entity in one request observe
   *    each other, and a duplicate within a single batch is caught exactly like a duplicate
   *    across two requests. A group's final state is written once, after its whole group has
   *    folded — not once per event — so a 10-event batch for one Step is one upsert, not ten.
   * 4. A group's transaction failing is CONTAINED to that group (tester finding D2,
   *    2026-08-20): every other group's results — including groups already committed before
   *    this one ran — still land in the response, and this group's own events still get a
   *    result each (REJECTED), never silently dropped. See `PROCESSING_FAILED` below.
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

      // F2 fix (tester regression, 2026-08-19): a U+0000 or lone-surrogate value passes
      // every Zod schema (IdSchema/NameSchema accept both) but Postgres rejects it at the
      // wire level — an uncaught 500 that can leave earlier events in the SAME batch already
      // persisted. Reject event-level, exactly like EVENT_TOO_LARGE, before it ever reaches
      // the repository. INVALID_PAYLOAD is the existing code that fits: this event's payload
      // is not acceptable, the same category `parseTelemetryEvent` already uses for a
      // Zod-shape failure.
      if (containsUnsafeUnicode(event)) {
        results[index] = {
          eventId: event.eventId,
          status: 'REJECTED',
          error: {
            code: INGEST_ERROR_CODES.INVALID_PAYLOAD,
            message: 'event contains a null byte or an unpaired unicode surrogate',
          },
        };
        rejected++;
        continue;
      }

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
      let groupResults: { index: number; result: IngestResult }[];
      try {
        groupResults = await this.repository.withEntityLock(
          group.kind,
          group.entityId,
          group.runId,
          (existing) => {
            let state = existing;
            const seen = collectKnownEventIds(existing);
            const outcomes: { index: number; result: IngestResult }[] = [];

            for (const { index, event } of group.items) {
              if (seen.has(event.eventId)) {
                outcomes.push({ index, result: { eventId: event.eventId, status: 'DUPLICATE' } });
                continue;
              }
              seen.add(event.eventId);
              state = mergeEvent(state, toMergeEvent(event, receivedAt));
              outcomes.push({ index, result: { eventId: event.eventId, status: 'ACCEPTED' } });
            }

            return { state, value: outcomes };
          },
        );
      } catch (error) {
        // D2 containment (tester finding, 2026-08-20): this group's transaction rolled back
        // (or never committed) — nothing for it was persisted, so ACCEPTED/DUPLICATE can
        // never be determined and REJECTED is the only honest classification. What must NOT
        // happen is this exception reaching the controller: that would discard every OTHER
        // group's results too, including ones already committed by an earlier iteration of
        // this very loop, and return zero per-event results for a batch this process
        // partially processed (MVP_PLAN_V3.md §12: "a malformed event never rejects the
        // whole batch"; every processed batch carries per-event results).
        //
        // Known triggers still live at the Postgres/Node boundary despite being Zod-legal
        // input: `occurredAt` year 0000 (Postgres SQLSTATE 22008), a `metadata` object
        // nested deep enough to overflow `structuredClone`'s call stack inside `mergeEvent`
        // (RangeError), and lock contention past Prisma's transaction timeout. This service
        // is not required to make any of those inputs succeed — only to report them as
        // event-level results inside a 200 response instead of losing the batch.
        //
        // `PROCESSING_FAILED` is not one of `INGEST_ERROR_CODES` — `platform/shared` is
        // outside this lane's `allowed_paths` — but `IngestResultErrorSchema.code` is
        // `z.string()`, not the closed union, specifically so a caller-facing code can be
        // added without ever failing an old SDK's parse (platform/shared/schema/ingest.ts).
        const message = error instanceof Error ? error.message : String(error);
        groupResults = group.items.map(({ index, event }) => ({
          index,
          result: {
            eventId: event.eventId,
            status: 'REJECTED',
            error: {
              code: 'PROCESSING_FAILED',
              message: `could not persist ${group.kind} ${group.entityId}: ${message}`,
            },
          },
        }));
      }

      for (const { index, result } of groupResults) {
        results[index] = result;
        if (result.status === 'DUPLICATE') {
          duplicate++;
        } else if (result.status === 'REJECTED') {
          rejected++;
        } else {
          accepted++;
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
