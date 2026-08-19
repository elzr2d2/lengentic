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
