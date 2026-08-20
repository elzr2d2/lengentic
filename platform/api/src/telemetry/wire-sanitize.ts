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
// })` — always a syntactically valid ISO 8601 timestamp with a 4-digit year, `0000`-`9999`.
// Postgres's `timestamptz` accepts every one of those years EXCEPT `0000`: confirmed live
// against this project's own Postgres instance, `'0000-01-01T00:00:00.000Z'::timestamptz`
// raises `22008 date/time field value out of range` while `'0001-01-01T00:00:00.000Z'` (and
// every year up to `9999`, both comfortably inside Postgres's actual range of 4713 BC to
// 294276 AD) succeeds. Postgres has no year zero — it runs 1 BC straight to 1 AD — so a bare
// "0000" year, which ISO 8601 permits and Postgres's date/time input does not, is the only
// value in this schema's entire output domain that can trigger it.
//
// Previously this reached `TelemetryRepository` and threw a raw Postgres error from inside
// an entity group's transaction — which poisoned the WHOLE group (one row, one final
// upsert; a group sharing this entity cannot partially commit) and, worse, the group's
// catch block reported already-persisted sibling events as terminally REJECTED (tester
// findings T2/T3). Catching it here, event-level, before the event is ever folded into a
// group, keeps a genuinely bad `occurredAt` from ever reaching persistence at all — so any
// well-formed siblings in the same entity group fold and persist normally, exactly like any
// other event-level rejection (§12: "a malformed event rejects only itself").
export function isPostgresUnrepresentableTimestamp(occurredAt: string): boolean {
  return occurredAt.slice(0, 4) === '0000';
}
