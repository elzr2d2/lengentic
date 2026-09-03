import { INGEST_LIMITS, type Metadata } from '@lengentic/shared';

/**
 * §15 Payload Safety — the one shared client-side safe serializer.
 *
 * The required order is stated in §15 and implemented literally here:
 *
 *   safe serialization → redaction → size cap / truncation
 *     → stable sanitized fingerprint where required → enqueue
 *
 * It applies to **every arbitrary JSON field**, not only ToolCall input/output:
 * `Run.metadata`, `Step.metadata`, `Decision.rawContext`, `ModelCall.metadata`,
 * `ToolCall.input`/`output` and `Error.metadata`. `handles.ts` is the only place a payload
 * is constructed, so it is the only caller — one producer, one pipeline, no second copy to
 * drift.
 *
 * Nothing in this module throws. §16: "The record methods must not throw because of
 * circular data, redaction failure, serialization failure, transport failure, or buffer
 * overflow." Serialization and redaction are two of those five, and they are answered here
 * rather than by the client's backstop `catch` — a backstop that fires has already lost the
 * event, and §15 requires the sanitized payload to still ship.
 */

const encoder = new TextEncoder();

/** §15: "Size cap — Default 32KB per field." */
export const DEFAULT_MAX_FIELD_BYTES = 32 * 1024;

/**
 * A per-field cap above §12's per-event cap cannot be honoured — the event carrying the
 * field would be dropped whole by `checkEnvelope` before the field cap ever mattered.
 */
export const MAX_FIELD_BYTES_CEILING = INGEST_LIMITS.maxEventPayloadBytes;

/** Below this a truncated record has no room for its own marker. */
export const MIN_FIELD_BYTES = 256;

export const REDACTED = '[REDACTED]';

/**
 * Reserved keys. Both start with `__lengentic` because a metadata record is the caller's
 * namespace and the SDK is a guest in it — a collision with a real caller key would
 * silently overwrite their data.
 */
export const TRUNCATION_KEY = '__lengenticTruncated';
export const REPLACED_KEY = '__lengenticValue';
const OVERFLOW_KEY = '__lengenticOverflow';

const CIRCULAR_MARK = '[Circular]';
const DEPTH_MARK = '[MaxDepth]';
const FUNCTION_MARK = '[Function]';
const INVALID_DATE_MARK = '[InvalidDate]';
const TRUNCATION_SUFFIX = '…[truncated]';

/**
 * Bounds on the walk itself, not on the payload. The byte cap below already decides what
 * ships; these stop a pathological structure (a million-element array, an object graph
 * built by a recursive generator) from costing a million sanitize steps to discover that.
 */
const MAX_DEPTH = 32;
const MAX_ITEMS = 1_000;

/** §15's hook, verbatim: `redact?: (value: unknown, path: string) => unknown`. */
export type Redactor = (value: unknown, path: string) => unknown;

export interface PayloadSafetyOptions {
  readonly redact?: Redactor | undefined;
  readonly maxFieldBytes?: number | undefined;
  readonly captureToolIO?: boolean | undefined;
}

/** The §15 measurements for one ToolCall, in the shape `tool_call.recorded` requires. */
export interface SafeToolIO {
  readonly input: unknown;
  readonly output: unknown;
  readonly inputTruncated: boolean;
  readonly outputTruncated: boolean;
  /**
   * The size of the sanitized value **before** the cap, not the size of what shipped.
   * §15: "Truncation must lose the payload, not the measurement." A reader that sees
   * `inputTruncated: true` and `inputBytes: 1048576` knows exactly what was dropped;
   * reporting the post-cap 32768 would lose the only fact truncation leaves behind.
   *
   * Under `captureToolIO: false` both counts are `null` (Reviewer S3, Phase 4 phase gate
   * repair attempt 1 — previously `0`) — nothing was serialized, so there is no measurement.
   * `null` there means "not captured"; a real, measured value of `0` is still `0`. The wire
   * contract now has this third state (`ToolCallRecordedPayloadSchema.inputBytes`/
   * `outputBytes` are `.nullish()`), which is what lets `null` ride straight through
   * `handles.ts`'s `...io` spread without the `exactOptionalPropertyTypes` dance an
   * `undefined` value would force.
   */
  readonly inputBytes: number | null;
  readonly outputBytes: number | null;
}

export interface PayloadSafety {
  /** §15's opt-out, resolved. `false` disables input/output capture entirely. */
  readonly captureToolIO: boolean;
  /** Sanitize → redact → cap one arbitrary-JSON metadata field. */
  metadata(value: Metadata | null | undefined, path: string): Metadata | undefined;
  /**
   * Sanitize → redact → cap one caller-supplied FREE-TEXT field. Today that is exactly
   * `Error.message`, whose wire schema is a bare unbounded `z.string()`.
   *
   * §15 enumerates the arbitrary-JSON fields and `Error.message` is not among them — it is
   * not JSON, it is prose. It still passes through here for two reasons. The cap: §12's
   * 64KB per-event limit refuses the whole event, `type` and `stepId` included, long
   * before an unbounded message becomes a "4MB blob" — so capping is what KEEPS the
   * failure rather than what loses it, and `truncateString`'s own suffix carries the
   * marker in band because `error.recorded` has no `*Truncated` field to carry it. And the
   * hook: §15's `redact?: (value, path) => unknown` is the only mechanism that can reach a
   * secret embedded in prose, since the shipped defaults match on KEYS. Routing the field
   * through here is what puts it in front of that hook.
   */
  text(value: string, path: string): string;
  /** Sanitize → redact → cap ToolCall input and output, honouring `captureToolIO`. */
  toolIO(input: unknown, output: unknown): SafeToolIO;
  /**
   * §15: "Fingerprints are computed over sanitized, canonicalized data. Never fingerprint
   * raw secrets." Deliberately computed over the **uncapped** sanitized value: two
   * identical 1MB inputs must fingerprint alike whether or not the cap happened to fall
   * between them, and §20.2 groups a failing streak by exactly that equality.
   */
  fingerprint(value: unknown, path?: string): string;
}

/**
 * §15's shipped defaults: "Authorization headers, `/api[_-]?key/i`, bearer tokens".
 *
 * Exactly those three and no more. Widening this to `/secret|token|password/i` reads like a
 * free improvement and is not: `CLAUDE.md` ## Product claims — false positives are the
 * failure mode that kills this product, and a redacted `passwordPolicy: "min 8 chars"` is a
 * run a developer can no longer reconstruct. A caller who wants more supplies `redact`.
 */
const AUTHORIZATION_KEY = /^authorization$/i;
const API_KEY_KEY = /api[_-]?key/i;
const BEARER_VALUE = /^\s*bearer\s+\S/i;

export function defaultRedactor(value: unknown, path: string): unknown {
  const key = lastSegment(path);
  if (AUTHORIZATION_KEY.test(key) || API_KEY_KEY.test(key)) return REDACTED;
  if (typeof value === 'string' && BEARER_VALUE.test(value)) return REDACTED;
  return value;
}

/** `metadata.headers.Authorization` → `Authorization`; `input[2].apiKey` → `apiKey`. */
function lastSegment(path: string): string {
  const cut = Math.max(path.lastIndexOf('.'), path.lastIndexOf('['), path.lastIndexOf(']'));
  return cut === -1 ? path : path.slice(cut + 1);
}

export function createPayloadSafety(options: PayloadSafetyOptions = {}): PayloadSafety {
  const maxFieldBytes = options.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;
  const captureToolIO = options.captureToolIO ?? true;
  const redact = composeRedactors(options.redact);

  const prepare = (value: unknown, path: string): CappedField => {
    const sanitized = sanitizeValue(value, path, redact);
    return capField(sanitized.value, maxFieldBytes, sanitized.elided);
  };

  return {
    captureToolIO,

    metadata(value, path) {
      if (value === undefined || value === null) return undefined;
      const capped = prepare(value, path);
      if (isRecord(capped.value)) return capped.value;
      // Only reachable when a caller-supplied redactor replaces the whole record with a
      // scalar. The wire contract requires an object here, so the scalar is carried rather
      // than dropped — losing the caller's redaction decision would be worse than one
      // reserved key.
      return { [REPLACED_KEY]: capped.value };
    },

    text(value, path) {
      const redacted = sanitizeValue(value, path, redact).value;
      // A caller-supplied redactor may return anything at all. The wire contract requires a
      // string here, so a non-string replacement is carried as its JSON rather than
      // dropped — the same choice `metadata` makes above, for the same reason: losing the
      // caller's redaction decision would be worse than an odd-looking value.
      const asText = typeof redacted === 'string' ? redacted : safeStringify(redacted);
      return String(capField(asText, maxFieldBytes).value);
    },

    toolIO(input, output) {
      if (!captureToolIO) {
        return {
          input: null,
          output: null,
          inputTruncated: false,
          outputTruncated: false,
          inputBytes: null,
          outputBytes: null,
        };
      }
      const safeInput = prepare(input, 'input');
      const safeOutput = prepare(output, 'output');
      return {
        input: safeInput.value ?? null,
        output: safeOutput.value ?? null,
        inputTruncated: safeInput.truncated,
        outputTruncated: safeOutput.truncated,
        inputBytes: safeInput.originalBytes,
        outputBytes: safeOutput.originalBytes,
      };
    },

    fingerprint(value, path = 'value') {
      return fnv1a64(safeStringify(canonicalize(sanitizeValue(value, path, redact).value)));
    },
  };
}

/**
 * Convenience for §20.2's caller-owned `inputFingerprint`, with §15's default redaction.
 * `platform/analysis-engine/src/tool-call.ts`: "Stable hash over sanitized, canonicalized
 * input (§15, §20.2). Caller-owned. The engine never sees raw tool input or output — only
 * this." Exported so a caller can compute that hash with the same sanitizer the SDK uses,
 * which is what makes "never fingerprint raw secrets" mechanical rather than advisory.
 */
export function fingerprintOf(value: unknown): string {
  return createPayloadSafety().fingerprint(value, 'input');
}

/**
 * The user hook runs first, the §15 defaults second. That order is the security-relevant
 * one: defaults become a floor a caller cannot accidentally remove, while a caller can
 * still inspect the original value before the defaults have replaced it.
 *
 * A hook that throws yields `REDACTED`, not the original — a redactor whose behaviour is
 * unknown must fail closed, and §16 forbids "redaction failure" from throwing at all.
 */
function composeRedactors(hook: Redactor | undefined): Redactor {
  if (hook === undefined) return defaultRedactor;
  return (value, path) => {
    let intermediate: unknown;
    try {
      intermediate = hook(value, path);
    } catch {
      return REDACTED;
    }
    return defaultRedactor(intermediate, path);
  };
}

const NO_REDACTION: Redactor = (value) => value;

interface Walk {
  readonly redact: Redactor;
  /** Objects on the *current path*, added before descent and removed after — so a DAG that
   *  reaches the same node twice is not misreported as a cycle. */
  readonly seen: Set<object>;
  /**
   * Set when MAX_ITEMS or MAX_DEPTH drops part of the value. Shared by reference across the
   * whole walk, and it is what makes the walk bounds honest: a 20 000-element array of tiny
   * items never reaches the byte cap, so without this the elision would be a silent loss
   * with `*Truncated: false` beside it — the exact "green that lies" §15's flag exists to
   * prevent.
   */
  readonly elided: { value: boolean };
}

export interface SanitizedValue {
  readonly value: unknown;
  /** True when the walk itself dropped something, independently of the byte cap. */
  readonly elided: boolean;
}

export function sanitizeValue(value: unknown, path: string, redact: Redactor): SanitizedValue {
  const elided = { value: false };
  const result = sanitize(value, path, { redact, seen: new Set<object>(), elided }, 0);
  return { value: result, elided: elided.value };
}

function sanitize(value: unknown, path: string, walk: Walk, depth: number): unknown {
  const redacted = safeRedact(value, path, walk.redact);
  // A replacement is the caller's own value and is not offered to the redactor again —
  // re-redacting `[REDACTED]` is pointless, and re-redacting a substituted object would let
  // a hook that returns its argument's parent loop.
  const next: Walk =
    redacted === value ? walk : { redact: NO_REDACTION, seen: walk.seen, elided: walk.elided };
  return jsonSafe(redacted, path, next, depth);
}

function safeRedact(value: unknown, path: string, redact: Redactor): unknown {
  try {
    return redact(value, path);
  } catch {
    return REDACTED;
  }
}

function jsonSafe(value: unknown, path: string, walk: Walk, depth: number): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    // JSON has no NaN and no Infinity; `JSON.stringify` turns both into `null`, which reads
    // as "absent". The string keeps the fact.
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return value.toString();
    case 'undefined':
      return undefined;
    case 'function':
      return FUNCTION_MARK;
    case 'symbol':
      return value.toString();
    case 'object':
      break;
  }

  const object = value;
  if (walk.seen.has(object)) return CIRCULAR_MARK;
  if (depth >= MAX_DEPTH) {
    walk.elided.value = true;
    return DEPTH_MARK;
  }

  walk.seen.add(object);
  try {
    return sanitizeObject(object, path, walk, depth);
  } finally {
    walk.seen.delete(object);
  }
}

function sanitizeObject(object: object, path: string, walk: Walk, depth: number): unknown {
  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? INVALID_DATE_MARK : object.toISOString();
  }
  if (object instanceof RegExp) return String(object);
  if (object instanceof Error) return { name: object.name, message: object.message };
  if (object instanceof Map) return sanitizeRecord(mapEntries(object), path, walk, depth);
  if (object instanceof Set) return sanitizeList(setItems(object), path, walk, depth);
  if (Array.isArray(object)) return sanitizeList(object, path, walk, depth);
  // `Object.values` on a typed array yields its elements; on a DataView it yields nothing,
  // which is the right answer — a DataView has no elements, only a window onto a buffer.
  if (ArrayBuffer.isView(object)) return sanitizeList(Object.values(object), path, walk, depth);

  const viaToJson = callToJson(object);
  if (viaToJson !== object) return jsonSafe(viaToJson, path, walk, depth + 1);

  return sanitizeRecord(ownEntries(object), path, walk, depth);
}

function sanitizeList(
  items: readonly unknown[],
  path: string,
  walk: Walk,
  depth: number,
): unknown[] {
  const kept = Math.min(items.length, MAX_ITEMS);
  const out: unknown[] = [];
  for (let index = 0; index < kept; index += 1) {
    // `undefined` is not a JSON value and `JSON.stringify` writes `null` for it in an
    // array. Doing it here keeps the sanitized tree and its serialization identical, so a
    // byte measurement over one describes the other.
    const child = sanitize(items[index], `${path}[${index}]`, walk, depth + 1);
    out.push(child === undefined ? null : child);
  }
  if (items.length > kept) {
    walk.elided.value = true;
    out.push(moreMark(items.length - kept, 'item'));
  }
  return out;
}

function sanitizeRecord(
  entries: ReadonlyArray<readonly [string, unknown]>,
  path: string,
  walk: Walk,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const kept = Math.min(entries.length, MAX_ITEMS);
  for (let index = 0; index < kept; index += 1) {
    const [key, raw] = entries[index] as readonly [string, unknown];
    const child = sanitize(raw, path === '' ? key : `${path}.${key}`, walk, depth + 1);
    if (child !== undefined) out[key] = child;
  }
  if (entries.length > kept) {
    walk.elided.value = true;
    out[OVERFLOW_KEY] = moreMark(entries.length - kept, 'key');
  }
  return out;
}

/** Own enumerable properties, each read behind a guard: §15 requires surviving a throwing getter. */
function ownEntries(object: object): Array<readonly [string, unknown]> {
  let keys: string[];
  try {
    keys = Object.keys(object);
  } catch (error) {
    return [[REPLACED_KEY, unreadable(error)]];
  }
  return keys.map((key) => {
    try {
      return [key, (object as Record<string, unknown>)[key]] as const;
    } catch (error) {
      return [key, unreadable(error)] as const;
    }
  });
}

function mapEntries(map: Map<unknown, unknown>): Array<readonly [string, unknown]> {
  try {
    return [...map.entries()].map(([key, value]) => [describeKey(key), value] as const);
  } catch (error) {
    return [[REPLACED_KEY, unreadable(error)]];
  }
}

function setItems(set: Set<unknown>): unknown[] {
  try {
    return [...set];
  } catch (error) {
    return [unreadable(error)];
  }
}

/** A Map key may be anything; a JSON object key may not. */
function describeKey(key: unknown): string {
  if (typeof key === 'string') return key;
  if (typeof key === 'object' && key !== null) return `[${key.constructor?.name ?? 'object'}]`;
  return String(key);
}

/** Honours `toJSON()` (URL, Luxon, Temporal, a caller's own value object) without trusting it. */
function callToJson(object: object): unknown {
  const candidate = (object as { toJSON?: unknown }).toJSON;
  if (typeof candidate !== 'function') return object;
  try {
    return (candidate as () => unknown).call(object);
  } catch (error) {
    return unreadable(error);
  }
}

function unreadable(error: unknown): string {
  return `[Unreadable: ${error instanceof Error ? error.message : String(error)}]`;
}

function moreMark(count: number, noun: string): string {
  return `[truncated: ${count} more ${noun}(s)]`;
}

// ---------------------------------------------------------------------------------------
// Size cap / truncation
// ---------------------------------------------------------------------------------------

export interface CappedField {
  readonly value: unknown;
  readonly truncated: boolean;
  /** Bytes of what ships. */
  readonly bytes: number;
  /** Bytes of the sanitized value before the cap. */
  readonly originalBytes: number;
}

export function capField(value: unknown, maxBytes: number, elided = false): CappedField {
  const originalBytes = jsonBytes(value);
  if (originalBytes <= maxBytes) {
    return { value, truncated: elided, bytes: originalBytes, originalBytes };
  }

  let shrunk = shrink(value, maxBytes);
  let bytes = jsonBytes(shrunk);
  if (bytes > maxBytes) {
    // The greedy shrink is an accounting estimate; this is the guarantee. §15: "Never
    // silently store a 4MB blob" is a statement about what leaves the process, so the cap
    // is verified against the real serialization rather than against the estimate.
    shrunk = hardPreview(value, maxBytes);
    bytes = jsonBytes(shrunk);
  }
  return { value: shrunk, truncated: true, bytes, originalBytes };
}

function shrink(value: unknown, budget: number): unknown {
  if (jsonBytes(value) <= budget) return value;
  if (typeof value === 'string') return truncateString(value, budget);
  if (Array.isArray(value)) return shrinkList(value, budget);
  if (isRecord(value)) return shrinkRecord(value, budget);
  return truncateString(safeStringify(value), budget);
}

function shrinkList(items: readonly unknown[], budget: number): unknown[] {
  const reserve = jsonBytes(moreMark(items.length, 'item')) + 1;
  const out: unknown[] = [];
  let used = 2; // `[` and `]`
  for (const item of items) {
    const piece = shrink(item, Math.max(0, budget - used - reserve));
    const cost = jsonBytes(piece) + (out.length > 0 ? 1 : 0);
    if (used + cost + reserve > budget) break;
    out.push(piece);
    used += cost;
  }
  out.push(moreMark(items.length - out.length, 'item'));
  return out;
}

function shrinkRecord(record: Record<string, unknown>, budget: number): Record<string, unknown> {
  const reserve = jsonBytes(TRUNCATION_KEY) + ':true,'.length;
  const out: Record<string, unknown> = {};
  let used = 2; // `{` and `}`
  let count = 0;
  for (const [key, item] of Object.entries(record)) {
    const piece = shrink(item, Math.max(0, budget - used - reserve));
    const cost = jsonBytes(key) + 1 + jsonBytes(piece) + (count > 0 ? 1 : 0);
    if (used + cost + reserve > budget) break;
    out[key] = piece;
    used += cost;
    count += 1;
  }
  out[TRUNCATION_KEY] = true;
  return out;
}

/** Always fits, for any `maxBytes >= MIN_FIELD_BYTES`. The floor under the greedy shrink. */
function hardPreview(value: unknown, maxBytes: number): unknown {
  if (isRecord(value)) return { [TRUNCATION_KEY]: true };
  return truncateString(safeStringify(value), maxBytes);
}

/**
 * The largest prefix whose JSON encoding still fits, found by binary search rather than by
 * estimating escape overhead — `"` and `\n` cost two bytes each and an emoji costs four, so
 * a character budget is not a byte budget and guessing one from the other is how a cap
 * quietly stops holding.
 */
function truncateString(text: string, budget: number): string {
  let low = 0;
  let high = Math.min(text.length, budget);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (jsonBytes(prefixOf(text, mid) + TRUNCATION_SUFFIX) <= budget) low = mid;
    else high = mid - 1;
  }
  return prefixOf(text, low) + TRUNCATION_SUFFIX;
}

/** Never cuts a surrogate pair in half — a lone surrogate is not valid text. */
function prefixOf(text: string, length: number): string {
  const cut = text.slice(0, length);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

// ---------------------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------------------

/** Key order is not information. Two records that differ only by it are the same context. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;

/**
 * FNV-1a, 64-bit, 16 hex characters. Deliberately **not** cryptographic: this is a grouping
 * key for §20.2, which additionally scopes a streak by `runId` and `toolName`, and the SDK
 * has no synchronous hash in its dependency budget — `crypto.subtle.digest` is async and
 * `node:crypto` would make the public artifact Node-only, which
 * `sdk-depends-on-shared-only` exists to prevent.
 */
function fnv1a64(text: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of encoder.encode(text)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & U64;
  }
  return hash.toString(16).padStart(16, '0');
}

// ---------------------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Never throws: by this point the value is sanitized, and the guard covers the rest. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '"[Unserializable]"';
  }
}

/** Bytes of the value's JSON encoding — quotes and escapes included, because they ship. */
function jsonBytes(value: unknown): number {
  return encoder.encode(safeStringify(value)).length;
}
