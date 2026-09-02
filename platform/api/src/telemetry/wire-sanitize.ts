import type { TelemetryEvent, TelemetryEventOf, TelemetryEventType } from '@lengentic/shared';

// F2 fix (tester regression, 2026-08-19): a value that is otherwise perfectly valid JSON can
// still contain a U+0000 code point or an unpaired ("lone") UTF-16 surrogate — the realistic
// outcome §12's client-side capping rule warns about: truncating a string mid-emoji splits a
// surrogate pair, leaving one half behind. Postgres rejects both at the wire level (`jsonb`
// input, and any `text`/`varchar` column) with "invalid byte sequence for encoding UTF8" —
// an error `parseTelemetryEvent` cannot catch, because Zod's `z.string()` accepts both.
//
// This runs AFTER `parseTelemetryEvent` succeeds, as an event-level rejection alongside
// EVENT_TOO_LARGE (ADR 0006) — never a request-level 400 (§12: "A malformed event never
// rejects the whole batch").

const SURROGATE_HIGH_START = 0xd800;
const SURROGATE_HIGH_END = 0xdbff;
const SURROGATE_LOW_START = 0xdc00;
const SURROGATE_LOW_END = 0xdfff;

/**
 * True if `value` contains a U+0000 code point or a UTF-16 code unit in the surrogate range
 * (`D800`-`DFFF`) that is not part of a valid high/low pair. A genuine emoji or other
 * astral-plane character (a correctly paired high+low surrogate) is untouched — only a LONE
 * surrogate, the signature of a truncation that split a pair, trips this.
 */
function hasNulOrLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);

    if (code === 0) return true;

    if (code >= SURROGATE_HIGH_START && code <= SURROGATE_HIGH_END) {
      const next = value.charCodeAt(i + 1);
      if (next >= SURROGATE_LOW_START && next <= SURROGATE_LOW_END) {
        i++; // valid pair — skip the low surrogate, it is not a lone code unit either
        continue;
      }
      return true; // high surrogate with no low surrogate following it
    }

    if (code >= SURROGATE_LOW_START && code <= SURROGATE_LOW_END) {
      return true; // low surrogate with no high surrogate preceding it
    }
  }
  return false;
}

/**
 * Recursively scans every string leaf of an already-parsed event (object keys included, not
 * only values) for `hasNulOrLoneSurrogate`. Values reaching Postgres always originate from
 * `JSON.parse`d wire input, so no cycles are possible — this never needs cycle protection.
 */
export function containsUnsafeUnicode(value: unknown): boolean {
  if (typeof value === 'string') {
    return hasNulOrLoneSurrogate(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsUnsafeUnicode);
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (hasNulOrLoneSurrogate(key) || containsUnsafeUnicode(nested)) return true;
    }
  }
  return false;
}

// ADR 0010 / tester finding T2 (2026-08-20): `occurredAt` is `z.iso.datetime({ offset: true
// })` — always a syntactically valid ISO 8601 timestamp with a 4-digit year, `0000`-`9999`,
// optionally shifted by an offset. Postgres's `timestamptz` accepts every UTC calendar year
// EXCEPT `0000` (and below): confirmed live against this project's own Postgres instance,
// `'0000-01-01T00:00:00.000Z'::timestamptz` raises `22008 date/time field value out of
// range` while `'0001-01-01T00:00:00.000Z'` (and every year up to `9999`, both comfortably
// inside Postgres's actual range of 4713 BC to 294276 AD) succeeds. Postgres has no year
// zero — it runs 1 BC straight to 1 AD.
//
// Previously this reached `TelemetryRepository` and threw a raw Postgres error from inside
// an entity group's transaction — which poisoned the WHOLE group (one row, one final
// upsert; a group sharing this entity cannot partially commit) and, worse, the group's
// catch block reported already-persisted sibling events as terminally REJECTED (tester
// findings T2/T3). Catching it here, event-level, before the event is ever folded into a
// group, keeps a genuinely bad `occurredAt` from ever reaching persistence at all — so any
// well-formed siblings in the same entity group fold and persist normally, exactly like any
// other event-level rejection (§12: "a malformed event rejects only itself").
//
// Repair attempt 3 (tester finding F-3, 2026-08-20): the FIRST fix here compared the
// literal wire text (`occurredAt.slice(0, 4) === '0000'`), which checks the wrong thing —
// `TimestampSchema` allows an explicit UTC offset, and the offset shifts the INSTANT
// Postgres actually stores, not merely how it is spelled. `'0001-01-01T00:00:00.000+05:00'`
// reads year `0001` in the literal text but names the UTC instant
// `0000-12-31T19:00:00.000Z` — year `0000` — and Postgres rejected it live with the same
// SQLSTATE `22008`, while the literal-text guard let it straight through to the entity
// fold, reproducing the exact group-poisoning defect this function exists to prevent.
// Conversely a literal `'0000-...'` shifted FORWARD by a negative offset (e.g.
// `'0000-12-31T20:00:00.000-05:00'`, UTC `0001-01-01T01:00:00.000Z`) is genuinely
// representable and must not be rejected. The only correct check is on the resulting UTC
// calendar year, not the wire text: `Date.parse`/`new Date(...)` already normalizes any
// valid `TimestampSchema` value (parsed the same way `merge-rules.ts`'s
// `compareOccurredAt` does) to its true instant, so `getUTCFullYear()` on that instant is
// the property Postgres actually enforces. `<= 0` (not just `=== 0`) covers the same "no
// year zero, no year before it either" boundary an offset can reach from a `0000` literal.
export function isPostgresUnrepresentableTimestamp(occurredAt: string): boolean {
  return new Date(occurredAt).getUTCFullYear() <= 0;
}

// ADR 0010 / tester findings F-1, F-3, F-6 (2026-08-20, repair attempt 3 — the third attempt
// at this exact defect class, so this fixes the CLASS, not another single input shape).
//
// The class: `MetadataSchema` (`platform/shared/schema/primitives.ts`) is
// `z.record(z.string(), z.unknown())` — Zod validates that `metadata` (and everything else
// carried in `payload`) is a plain object with string keys, but never bounds how deeply a
// `z.unknown()` VALUE nests, because it never looks inside one. A sufficiently deep,
// Zod-legal `metadata` object therefore reaches two independent recursive walks downstream
// of `parseTelemetryEvent`, each of which can overflow V8's call stack: `containsUnsafeUnicode`
// above (this same per-event stage) and, if that survives, `structuredClone` inside
// `merge-rules.ts`'s `mergeEvent` — called only AFTER the event has been grouped, i.e.
// inside the entity fold, past the point where a per-event `try`/`catch` can turn the throw
// into a per-event verdict. The two do not overflow at the same depth (`containsUnsafeUnicode`
// survives to roughly 9000-10000 in this project's own measurements;
// `structuredClone`-inside-`mergeEvent` throws far lower, around 1500), and NEITHER
// threshold is stable across processes or stack states (ADR 0010 Detection, T5: "depth is
// not a stable threshold... 7000 escaped as a single event; 8000 was contained in a batch;
// >=9000 escaped on every attempt"). The first two repair attempts each caught only the
// higher of the two thresholds (whichever one their fixture happened to probe), leaving the
// other reachable — a poison event in the gap slipped past every per-event check, got
// grouped, and threw INSIDE the fold: a per-event problem surfacing as a per-request 500
// with zero results, destroying every well-formed sibling in the batch.
//
// The fix is to stop relying on catching an overflow after the fact and instead bound the
// structure BEFORE either recursive walk ever sees it — event-level, like
// `isPostgresUnrepresentableTimestamp` above, so a well-formed sibling in the same entity
// group still folds and persists. `MAX_STRUCTURAL_DEPTH` is chosen with a wide safety
// margin below the LOWEST observed overflow (~1500), not tuned to the observed band — the
// band itself is stack-size dependent and is not a stable contract to pin a threshold
// against. The walk below is ITERATIVE (an explicit array as a heap-allocated stack, never
// native recursion), so unlike `containsUnsafeUnicode` and `structuredClone` it cannot
// overflow at any input depth — it is safe to run first, on every event, without risking
// becoming the next version of the same bug.
export const MAX_STRUCTURAL_DEPTH = 64;

/**
 * True if `value` nests an object or array inside another more than `maxDepth` levels deep.
 * A bare leaf (string/number/boolean/null) is depth 0; each object/array level below it
 * adds one. Iterative (no native recursion) so it is safe to run on arbitrarily deep,
 * possibly-adversarial input without itself becoming a stack-overflow site.
 */
export function exceedsMaxStructuralDepth(
  value: unknown,
  maxDepth: number = MAX_STRUCTURAL_DEPTH,
): boolean {
  // Breadth-first, level by level: `frontier` holds every node at the CURRENT depth, never
  // a mix of depths, so there is nothing to destructure off a stack that TypeScript would
  // (correctly) type as possibly-`undefined`.
  let frontier: unknown[] = [value];
  for (let depth = 0; frontier.length > 0; depth++) {
    if (depth > maxDepth) return true;
    const next: unknown[] = [];
    for (const current of frontier) {
      if (Array.isArray(current)) {
        // `Array.isArray` narrows `unknown` to `any[]` under this project's lib target, not
        // `unknown[]` — the explicit annotation keeps the spread below type-safe
        // (@typescript-eslint/no-unsafe-argument) without weakening what is actually pushed.
        const items: unknown[] = current;
        next.push(...items);
      } else if (current !== null && typeof current === 'object') {
        const values: unknown[] = Object.values(current);
        next.push(...values);
      }
    }
    frontier = next;
  }
  return false;
}

// ADR 0014 / Reviewer finding R1 (2026-09-02, repair attempt 1 on `p4.entity-ingest`) — the
// FOURTH attempt at the defect class the two block comments above exist for, so, again, this
// fixes the CLASS rather than the input shape that was reported.
//
// The class: `isPostgresUnrepresentableTimestamp` above had exactly ONE call site
// (`telemetry.service.ts`'s `classifyEvent`) and it screened exactly ONE field,
// `event.occurredAt`. But `TimestampSchema` is one shared schema
// (`platform/shared/schema/primitives.ts`), and Phase 4 widened the wire contract with three
// more fields typed by it — `tool_call.recorded`'s `startedAt` and `completedAt`, and
// `decision.outcome_attested`'s `observedAt` — each landing in a `@db.Timestamptz(3)` column
// that enforces the same "Postgres has no year zero" rule `occurredAt`'s column does. All
// three went unscreened.
//
// Reproduced live against `postgres:17.6-alpine`
// (`.artifacts/evidence/4/p4.entity-ingest/coordinator/s1-confirmation.md`): a year-0000
// `startedAt` made `TelemetryService.ingest()` THROW with HTTP 500 and zero per-event
// results, from `ToolCallRepository.record` — SQLSTATE `22008`, `date/time field value out of
// range: "0000-01-01 00:00:00"`. Strictly worse than the original T2/T3 defect, because the
// entity-write path runs AFTER the Run/Step group loop: the sibling Run event in the same
// batch had ALREADY COMMITTED, so the caller could not even retry the batch to success — the
// identical payload threw again, every time, forever.
//
// The same seam carries the same hazard in a second currency. `latencyMs`, `inputTokens`,
// `outputTokens`, `inputBytes`, `outputBytes` and `durationMs` are all
// `z.number().int().nonnegative()` on the wire — unbounded above — and all six land in a
// Prisma `Int`, i.e. Postgres `int4` (verified column by column against
// `platform/database/prisma/schema.prisma`; not one of them is `BigInt`). A value past
// `POSTGRES_INT4_MAX` raises SQLSTATE `22003` from the identical code path with the identical
// permanent-poison result. Screening only the timestamps would have left a fifth repair
// attempt waiting at the same call site.
//
// The fix is the same shape as its two predecessors: reject event-level, in `classifyEvent`,
// BEFORE the event is grouped or queued for an entity write, so a malformed event rejects
// only itself (§12) and well-formed siblings in the same batch still land. It reuses
// `isPostgresUnrepresentableTimestamp` rather than introducing a second predicate that could
// drift from it — F-3's whole lesson was that a second, subtly different timestamp check is
// how the bypass got in.
//
// The screen is FIELD-TARGETED, not a recursive walk of the payload, and that is deliberate:
// `metadata`, `rawContext` and a tool call's `input`/`output` land in `jsonb`, which has
// neither of these bounds. A blind walk would reject a number or an ISO-looking string that
// Postgres stores perfectly well — a false positive on the ingest path, which is the failure
// mode `CLAUDE.md` ## Product claims warns about in the analyzer and which is no better here.
//
// The tables below are `satisfies`-checked against each payload's own `keyof`, so a RENAMED
// field is a compile error. A field ADDED to a payload schema cannot be caught at the type
// level — `TimestampSchema` erases to `string` and every int4 column erases to `number` — so
// `wire-sanitize.spec.ts` reads the real Zod schemas at runtime and fails if either table
// stops matching them. That guard is the part that makes this a fix to the class.

/**
 * The largest value a Postgres `int4` column can hold (2^31 - 1). Every numeric column the
 * Phase 4 entity types write is `Int` in `platform/database/prisma/schema.prisma`; the wire
 * contract bounds none of them, so this is the only place the two are reconciled.
 */
export const POSTGRES_INT4_MAX = 2_147_483_647;

/** True if `value` is outside what a Postgres `int4` column can store. */
export function exceedsPostgresInt4(value: number): boolean {
  return value > POSTGRES_INT4_MAX || value < -POSTGRES_INT4_MAX - 1;
}

/**
 * Payload field names for one wire type, constrained to that type's own payload keys — a
 * renamed or misspelled field is a compile error rather than a silently-unscreened column.
 */
type PayloadFieldsOf<K extends TelemetryEventType> =
  readonly (keyof TelemetryEventOf<K>['payload'] & string)[];

type PersistedPayloadFieldMap = { readonly [K in TelemetryEventType]: PayloadFieldsOf<K> };

/**
 * Every `TimestampSchema`-typed payload field that reaches a `@db.Timestamptz(3)` column,
 * per wire type. Enumerated from the schemas themselves, never guessed — and pinned against
 * them at runtime by `wire-sanitize.spec.ts`'s drift guard.
 *
 * The four mergeable types are listed with empty tuples rather than omitted: the map is
 * exhaustive over `TelemetryEventType`, so a tenth wire type is a compile error here, which
 * is what forces whoever adds it to answer this question instead of inheriting a default.
 */
export const PERSISTED_PAYLOAD_TIMESTAMP_FIELDS: Readonly<
  Record<TelemetryEventType, readonly string[]>
> = {
  'run.started': [],
  'run.completed': [],
  'step.started': [],
  'step.completed': [],
  'decision.recorded': [],
  'decision.outcome_attested': ['observedAt'],
  'model_call.recorded': [],
  'tool_call.recorded': ['startedAt', 'completedAt'],
  'error.recorded': [],
} as const satisfies PersistedPayloadFieldMap;

/**
 * Every numeric payload field that reaches a Postgres `int4` column, per wire type. Same
 * exhaustiveness and the same runtime drift guard as the timestamp table above.
 */
export const PERSISTED_PAYLOAD_INT4_FIELDS: Readonly<
  Record<TelemetryEventType, readonly string[]>
> = {
  'run.started': [],
  'run.completed': [],
  'step.started': [],
  'step.completed': [],
  'decision.recorded': [],
  'decision.outcome_attested': [],
  'model_call.recorded': ['latencyMs', 'inputTokens', 'outputTokens'],
  'tool_call.recorded': ['inputBytes', 'outputBytes', 'durationMs'],
  'error.recorded': [],
} as const satisfies PersistedPayloadFieldMap;

/**
 * Why this event's payload cannot be stored, or `null` if it can. The returned string is the
 * `IngestResult.error.message` for a per-event `REJECTED` — the reason lives here, beside the
 * tables and the two predicates it is derived from, rather than at the call site.
 *
 * A `.nullish()` field that is absent or `null` is not unrepresentable: only a value actually
 * present, of the right primitive type, is screened.
 */
export function unrepresentablePayloadReason(event: TelemetryEvent): string | null {
  const payload: unknown = event.payload;
  if (payload === null || typeof payload !== 'object') return null;
  const fields = payload as Record<string, unknown>;

  for (const field of PERSISTED_PAYLOAD_TIMESTAMP_FIELDS[event.type]) {
    const value = fields[field];
    if (typeof value === 'string' && isPostgresUnrepresentableTimestamp(value)) {
      return `event payload field '${field}' names a date Postgres cannot store (year 0000 does not exist)`;
    }
  }

  for (const field of PERSISTED_PAYLOAD_INT4_FIELDS[event.type]) {
    const value = fields[field];
    if (typeof value === 'number' && exceedsPostgresInt4(value)) {
      return `event payload field '${field}' exceeds the largest value Postgres can store in its column (${POSTGRES_INT4_MAX})`;
    }
  }

  return null;
}
