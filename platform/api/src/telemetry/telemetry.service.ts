import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
  type HttpException,
} from '@nestjs/common';
import {
  IdSchema,
  INGEST_ERROR_CODES,
  INGEST_LIMITS,
  parseTelemetryEvent,
  type IngestResponse,
  type IngestResult,
} from '@lengentic/shared';
import {
  isMergeableEvent,
  mergeEntityKindOf,
  toMergeEvent,
  type EntityKind,
  type MergeableTelemetryEvent,
} from './event-mapping';
import { mergeEvent } from './merge-rules';
import { TelemetryRepository } from './telemetry.repository';
import {
  containsUnsafeUnicode,
  exceedsMaxStructuralDepth,
  isPostgresUnrepresentableTimestamp,
  MAX_STRUCTURAL_DEPTH,
} from './wire-sanitize';

interface BatchItem {
  readonly index: number;
  readonly event: MergeableTelemetryEvent;
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

// ADR 0010 (`docs/decisions/0010-infrastructure-failure-is-not-an-event-level-rejection.md`):
// a known infrastructure/dependency-unavailable condition is HTTP 503; every other
// unexpected persistence failure is HTTP 500. `platform/api` cannot import Prisma's error
// classes to `instanceof`-check them — `no-restricted-imports` blocks `@prisma/client` and
// `**/generated/prisma/**` here (CLAUDE.md ## Types: "Prisma types are database-internal and
// never cross a module boundary") — so this reads only the `.name`/`.code` string properties
// every Prisma error exposes on the `Error` shape all JS errors already have.
//
// Confirmed live, 2026-08-20, against this project's own Postgres instance (a throwaway
// database, migrated and torn down for the probe — `.artifacts/evidence/2/human-repair/`,
// `.artifacts/evidence/2/tester-human-repair/`, `.artifacts/evidence/2/builder-repair-3/`):
//   - Run table renamed away (T4's own fixture)  -> PrismaClientKnownRequestError code P2021
//   - connection refused (bad port)              -> PrismaClientKnownRequestError code ECONNREFUSED
//   - interactive-transaction timeout (T1's lock-contention fixture, past Prisma's own
//     5000ms transaction timeout) -> PrismaClientKnownRequestError code P2028
const KNOWN_DEPENDENCY_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED', // node-postgres's own code, passed through unwrapped by the driver adapter
  'P2021', // table does not exist — the schema this process depends on is not there
  'P2022', // column does not exist — same class as P2021
  'P2024', // timed out fetching a new connection from the pool
  'P2028', // transaction API error (an interactive transaction expired/timed out)
]);

// F-5 (tester finding, 2026-08-20; corrected by the Coordinator, repair attempt 3 round 2):
// P2010 is Prisma's GENERIC raw-query error — it fires for a statement cancelled under load
// (a transient, retryable dependency condition) and for a query this service's own code got
// wrong (a permanent defect) alike. The code alone cannot tell them apart; the two prior
// attempts each collapsed it to one branch (500-always, then 503-always) and were both
// wrong for the input the other branch covers. A permanently-broken query classified 503
// recreates F-6's shape in a different suit: a conforming SDK would retry a query that can
// never succeed, forever.
//
// Prisma's Postgres driver adapter exposes the ACTUAL Postgres SQLSTATE underneath a P2010,
// at `error.meta.driverAdapterError.cause.originalCode` — confirmed live via
// `platform/api/p2010-probe.mts` (throwaway, not committed) against two real Postgres
// failures on the SAME code path `TelemetryRepository.lockEntity`'s `$executeRaw` uses:
//   - `SET LOCAL statement_timeout = 300` + an externally-held advisory lock (the tester's
//     own `raw/statement-timeout.txt` recipe) -> code: P2010,
//     meta.driverAdapterError.cause.originalCode: "57014" (canceling statement due to
//     statement timeout — the canonical transient-overload SQLSTATE)
//   - `$queryRawUnsafe` against a column that does not exist -> code: P2010,
//     meta.driverAdapterError.cause.originalCode: "42703" (undefined_column — a permanent
//     query defect, not a dependency condition)
// Full captures: `.artifacts/evidence/2/builder-repair-3/p2010-sqlstate-probe.txt`.
const RETRYABLE_RAW_QUERY_SQLSTATES = new Set([
  '57014', // canceling statement due to statement timeout — the one SQLSTATE this repair
  // has live evidence for. Any other SQLSTATE under a P2010 falls through to the 500
  // default below, which is the conservative direction (a caller told 500 still retries
  // safely; a caller told 503 for a permanent defect retries forever).
]);

const PRISMA_ERROR_NAMES = new Set([
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
  'PrismaClientInitializationError',
  'PrismaClientRustPanicError',
]);

function errorCode(error: Error): string | undefined {
  if (!('code' in error)) return undefined;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The Postgres SQLSTATE underneath a raw-query Prisma error (P2010), read from the driver
 * adapter's own error shape — `error.meta.driverAdapterError.cause.originalCode`. Every
 * layer is read defensively (`typeof` narrowed, never cast) because `.meta`'s shape is
 * Prisma-adapter-internal, not a documented contract this project owns.
 */
function rawQuerySqlState(error: Error): string | undefined {
  const meta: unknown = (error as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return undefined;

  const driverAdapterError: unknown = (meta as Record<string, unknown>).driverAdapterError;
  if (typeof driverAdapterError !== 'object' || driverAdapterError === null) return undefined;

  const cause: unknown = (driverAdapterError as Record<string, unknown>).cause;
  if (typeof cause !== 'object' || cause === null) return undefined;

  const originalCode: unknown = (cause as Record<string, unknown>).originalCode;
  return typeof originalCode === 'string' ? originalCode : undefined;
}

function isKnownDependencyUnavailable(error: unknown): boolean {
  if (!(error instanceof Error) || !PRISMA_ERROR_NAMES.has(error.name)) return false;

  // Initialization failures and Rust-side panics mean the client never had a usable
  // connection to begin with — always a connectivity-level condition, no `.code` to check.
  if (error.name !== 'PrismaClientKnownRequestError') return true;

  const code = errorCode(error);
  if (code === undefined) return false;

  // P2010 is ambiguous by code alone (see the block comment above) — discriminate on the
  // SQLSTATE it actually carries instead of trusting the Prisma code.
  if (code === 'P2010') {
    const sqlState = rawQuerySqlState(error);
    return sqlState !== undefined && RETRYABLE_RAW_QUERY_SQLSTATES.has(sqlState);
  }

  return KNOWN_DEPENDENCY_UNAVAILABLE_CODES.has(code) || /^P10\d\d$/.test(code);
}

/**
 * `AllExceptionsFilter` already replaces any 5xx exception's message with the generic
 * "Internal server error" string before it reaches the wire (`status >= 500` — true for
 * both 503 and 500), so the message passed to these constructors below is server-side
 * documentation only (visible in logs, never in the response body) — T1's sanitization
 * lives in that filter, not here. This function's only externally-visible effect is which
 * HTTP status the caller sees.
 */
function classifyPersistenceFailure(error: unknown): HttpException {
  if (isKnownDependencyUnavailable(error)) {
    return new ServiceUnavailableException(
      'telemetry storage is temporarily unavailable; retry the batch',
    );
  }
  return new InternalServerErrorException('telemetry batch could not be processed');
}

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(private readonly repository: TelemetryRepository) {}

  /**
   * POST /v1/telemetry/events. §12's whole per-event contract in one pass:
   *
   * 1. Event-level rejection (size, then schema, then structural depth, then wire-safety,
   *    then timestamp representability) never fails the batch — every raw event gets
   *    exactly one `IngestResult`, regardless of what happens to its neighbours. The whole
   *    per-event stage runs inside a per-event `try`/`catch` as a backstop, but the
   *    structural-depth check (tester findings F-1/F-3/F-6, 2026-08-20, repair attempt 3;
   *    formerly T5) is what actually closes the hazard rather than merely catching it:
   *    `metadata` (`MetadataSchema` is `z.record(z.string(), z.unknown())`) never has its
   *    nesting bounded by Zod, and a sufficiently deep one can overflow V8's call stack in
   *    `containsUnsafeUnicode` below OR, past this per-event stage, in `structuredClone`
   *    inside `mergeEvent` — two DIFFERENT, unstable thresholds (see `wire-sanitize.ts`),
   *    the second of which throws INSIDE the entity fold, past where this `try`/`catch` can
   *    turn it into a per-event verdict. `exceedsMaxStructuralDepth` rejects event-level,
   *    before either walk runs, so neither threshold is ever reached from a normal request.
   * 2. Accepted events are grouped by entity (`kind:entityId`).
   * 3. Each group is folded and saved as ONE atomic unit via
   *    `TelemetryRepository.withEntityLock` (F1 fix, tester regression 2026-08-19): the
   *    load, the `mergeEvent` fold IN BATCH ORDER, and the save all happen inside a single
   *    Postgres transaction guarded by an advisory lock on that entity, so a concurrent
   *    request touching the same `entityId` cannot interleave its own read-modify-write and
   *    silently discard this one's contribution. Within the fold, the `IngestedEvent` ledger
   *    (ADR 0005 §1 / ADR 0009, F3) seeds `seen` and the entity's persisted state seeds
   *    `state` — so two events for the same entity in one request observe each other, and a
   *    duplicate within a single batch is caught exactly like a duplicate across two
   *    requests, whether or not the repeated event ever won a merge contest. A group's final
   *    state is written once, after its whole group has folded — not once per event — so a
   *    10-event batch for one Step is one upsert, not ten (and, symmetrically, one
   *    `IngestedEvent.createMany`, not ten single-row inserts).
   * 4. A group's transaction failing is an infrastructure/persistence failure, never an
   *    event-level verdict (ADR 0010, superseding the `PROCESSING_FAILED` design tester
   *    findings T1/T2/T3/T4 rejected 2026-08-20): `REJECTED` means the event itself is
   *    invalid, and a failed persistence attempt proves nothing of the kind about the events
   *    in that group — including, per T3, events this very request already knows are
   *    `DUPLICATE`s of rows that exist. This method aborts the whole response with a
   *    classified `HttpException` instead: groups already committed by an earlier iteration
   *    of this loop stay committed (each is its own transaction), the failing group's own
   *    transaction rolls back, and any group not yet reached is simply never attempted — the
   *    caller gets one honest 5xx and retries the whole batch, safely, because retry safety
   *    is the `IngestedEvent` ledger's job, not this endpoint's (F3, ADR 0009 — the ledger
   *    read/write lives inside `TelemetryRepository.withEntityLock`, so a group whose
   *    transaction never committed never recorded any of its events as ingested either). A
   *    caller that DOES receive 200 now knows every event in the batch got a real per-event
   *    verdict — that guarantee is the whole reason per-event results are worth returning at
   *    all.
   */
  async ingest(rawEvents: readonly unknown[]): Promise<IngestResponse> {
    const results = new Array<IngestResult>(rawEvents.length);
    let accepted = 0;
    let duplicate = 0;
    let rejected = 0;
    const groups = new Map<string, EntityGroup>();

    for (let index = 0; index < rawEvents.length; index++) {
      const raw = rawEvents[index];

      try {
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

        // F-1/F-3/F-6 fix (tester findings, 2026-08-20, repair attempt 3): bound how deeply
        // `event.payload` (in practice, `metadata` — the one field Zod never looks inside)
        // may nest, event-level, BEFORE either downstream recursive walk
        // (`containsUnsafeUnicode` just below, or `structuredClone` inside `mergeEvent`,
        // reached only once this event has been grouped) ever sees it. Both of those walks
        // can stack-overflow on a sufficiently deep, Zod-legal `metadata` object, at two
        // DIFFERENT and unstable depths (see `wire-sanitize.ts`) — a poison event between
        // the two thresholds used to slip past this per-event stage, get grouped, and throw
        // INSIDE the entity fold: a per-event problem surfacing as a per-request 500 with
        // zero results, destroying every well-formed sibling in the batch. Bounding it here
        // closes both thresholds with one check, and does so without risking becoming a
        // third unstable threshold itself — `exceedsMaxStructuralDepth` is iterative, not
        // recursive, so it cannot overflow at any input depth.
        if (exceedsMaxStructuralDepth(event.payload)) {
          results[index] = {
            eventId: event.eventId,
            status: 'REJECTED',
            error: {
              code: INGEST_ERROR_CODES.INVALID_PAYLOAD,
              message: `event payload nests more than ${MAX_STRUCTURAL_DEPTH} levels deep`,
            },
          };
          rejected++;
          continue;
        }

        // F2 fix (tester regression, 2026-08-19): a U+0000 or lone-surrogate value passes
        // every Zod schema (IdSchema/NameSchema accept both) but Postgres rejects it at the
        // wire level. Reject event-level, exactly like EVENT_TOO_LARGE, before it ever
        // reaches the repository. INVALID_PAYLOAD is the existing code that fits: this
        // event's payload is not acceptable, the same category `parseTelemetryEvent`
        // already uses for a Zod-shape failure.
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

        // T2/T3 fix (tester finding, 2026-08-20): `occurredAt` is Zod-legal for every year
        // `0000`-`9999`, but Postgres cannot store year `0000` (no year zero — see
        // `wire-sanitize.ts`). Reject event-level, before this event ever reaches a group,
        // so well-formed siblings in the SAME entity group still fold and persist — a
        // Postgres-level failure at save time would poison the whole group's one shared row
        // instead (one entity, one upsert).
        if (isPostgresUnrepresentableTimestamp(event.occurredAt)) {
          results[index] = {
            eventId: event.eventId,
            status: 'REJECTED',
            error: {
              code: INGEST_ERROR_CODES.INVALID_PAYLOAD,
              message:
                'event occurredAt names a date Postgres cannot store (year 0000 does not exist)',
            },
          };
          rejected++;
          continue;
        }

        // Phase 4 widened the wire contract to nine types; `merge-rules.ts` still folds
        // four. `entityKindOf` answers `null` for the five it cannot place, and this is
        // where that becomes a visible result rather than a Decision row written into the
        // Step table. Event-level, like every other rejection above: a batch that mixes
        // run/step events with decision events still lands the run/step ones.
        if (!isMergeableEvent(event)) {
          results[index] = {
            eventId: event.eventId,
            status: 'REJECTED',
            error: {
              code: INGEST_ERROR_CODES.EVENT_TYPE_NOT_INGESTIBLE,
              message: `event type '${event.type}' is part of the wire contract but has no server-side persistence yet`,
            },
          };
          rejected++;
          continue;
        }

        const kind = mergeEntityKindOf(event);
        const key = `${kind}:${event.entityId}`;
        let group = groups.get(key);
        if (!group) {
          group = { kind, entityId: event.entityId, runId: event.runId, items: [] };
          groups.set(key, group);
        }
        group.items.push({ index, event });
      } catch (error) {
        this.logger.warn(
          { err: error, index },
          'event-level validation failed unexpectedly; rejecting only this event',
        );
        results[index] = {
          eventId: readEventIdBestEffort(raw),
          status: 'REJECTED',
          error: {
            code: INGEST_ERROR_CODES.INVALID_PAYLOAD,
            message: 'event could not be validated',
          },
        };
        rejected++;
      }
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
          group.items.map((item) => item.event.eventId),
          receivedAt,
          (existing, alreadyIngested) => {
            let state = existing;
            const seen = new Set(alreadyIngested);
            const newlyIngestedEventIds: string[] = [];
            const outcomes: { index: number; result: IngestResult }[] = [];

            for (const { index, event } of group.items) {
              if (seen.has(event.eventId)) {
                outcomes.push({ index, result: { eventId: event.eventId, status: 'DUPLICATE' } });
                continue;
              }
              seen.add(event.eventId);
              newlyIngestedEventIds.push(event.eventId);
              state = mergeEvent(state, toMergeEvent(event, receivedAt));
              outcomes.push({ index, result: { eventId: event.eventId, status: 'ACCEPTED' } });
            }

            return { state, newlyIngestedEventIds, value: outcomes };
          },
        );
      } catch (error) {
        // ADR 0010: full internal detail is logged here, server-side only — never returned
        // to the caller. `classifyPersistenceFailure` decides 503 vs 500;
        // `AllExceptionsFilter` (`platform/api/src/common/all-exceptions.filter.ts`) is what
        // actually strips the message down to the generic "Internal server error" text on
        // the wire for any status >= 500, so no stack, path, SQL code or compiled source
        // from `error` below ever reaches the response body (tester finding T1).
        this.logger.error(
          { err: error, kind: group.kind, entityId: group.entityId },
          'entity group failed to persist',
        );
        throw classifyPersistenceFailure(error);
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
