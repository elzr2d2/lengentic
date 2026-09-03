import { describe, expect, it } from 'vitest';

import {
  createPayloadSafety,
  defaultRedactor,
  fingerprintOf,
  DEFAULT_MAX_FIELD_BYTES,
  REDACTED,
  REPLACED_KEY,
  TRUNCATION_KEY,
  type Redactor,
} from '../src/index';

/**
 * Seam: `createPayloadSafety` — §15's one shared client-side safe serializer, observed
 * through its public return value only. Nothing reaches inside the module.
 *
 * TEST-4: every expected value here is sourced independently of the code under test —
 * from §15's own words (32KB, the three credential shapes, the `*Truncated` flag), or
 * computed in the test with its own `TextEncoder` and `JSON.stringify`. Where a byte count
 * is asserted, the test measures it; it never reads the number the module reported and
 * compares it to itself.
 */

const encoder = new TextEncoder();

/** The test's own oracle for "how big is this on the wire", independent of the module. */
function measure(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? 'null').length;
}

const safety = createPayloadSafety();

describe('§15 safe serialization — survives what JSON.stringify cannot', () => {
  it('turns a circular reference into a marker instead of throwing', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;

    expect(() => JSON.stringify(node)).toThrow(); // the behaviour §15 exists to replace

    const safe = safety.metadata(node, 'metadata');

    expect(safe).toStrictEqual({ name: 'root', self: '[Circular]' });
    expect(() => JSON.stringify(safe)).not.toThrow();
  });

  it('does not mistake a repeated node for a cycle', () => {
    const shared = { id: 7 };
    const safe = safety.metadata({ left: shared, right: shared }, 'metadata');

    expect(safe).toStrictEqual({ left: { id: 7 }, right: { id: 7 } });
  });

  it('carries a BigInt across as its decimal value', () => {
    const value = 90071992547409911n;

    expect(() => JSON.stringify({ value })).toThrow();
    expect(safety.metadata({ value }, 'metadata')).toStrictEqual({
      value: '90071992547409911',
    });
  });

  it('expands a Map into an object and a Set into an array', () => {
    const safe = safety.metadata(
      {
        headers: new Map([
          ['content-type', 'application/json'],
          ['x-request-id', 'abc'],
        ]),
        tags: new Set(['retry', 'slow']),
      },
      'metadata',
    );

    // JSON.stringify renders both as `{}` — the entries are lost, not preserved.
    expect(JSON.stringify({ m: new Map([['a', 1]]), s: new Set([1]) })).toBe('{"m":{},"s":{}}');
    expect(safe).toStrictEqual({
      headers: { 'content-type': 'application/json', 'x-request-id': 'abc' },
      tags: ['retry', 'slow'],
    });
  });

  it('survives a getter that throws, and keeps the key', () => {
    const hostile = { ok: 1 };
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('detonated');
      },
    });

    expect(() => JSON.stringify(hostile)).toThrow('detonated');

    const safe = safety.metadata(hostile, 'metadata');

    expect(safe).toStrictEqual({ ok: 1, boom: '[Unreadable: detonated]' });
  });

  it('survives a toJSON() that throws', () => {
    const hostile = {
      toJSON() {
        throw new Error('no json for you');
      },
    };

    expect(safety.metadata({ wrapped: hostile }, 'metadata')).toStrictEqual({
      wrapped: '[Unreadable: no json for you]',
    });
  });

  it('keeps NaN and Infinity as facts rather than as null', () => {
    // JSON.stringify erases both, which reads downstream as "the field was absent".
    expect(JSON.stringify({ a: NaN, b: Infinity })).toBe('{"a":null,"b":null}');
    expect(safety.metadata({ a: NaN, b: Infinity }, 'metadata')).toStrictEqual({
      a: 'NaN',
      b: 'Infinity',
    });
  });

  it('renders a Date, an Error and a function without losing the key', () => {
    const safe = safety.metadata(
      {
        at: new Date('2026-08-31T09:00:00.000Z'),
        failure: new TypeError('bad input'),
        retry: () => undefined,
      },
      'metadata',
    );

    expect(safe).toStrictEqual({
      at: '2026-08-31T09:00:00.000Z',
      failure: { name: 'TypeError', message: 'bad input' },
      retry: '[Function]',
    });
  });
});

describe('§15 redaction — the three shipped defaults', () => {
  it.each([
    ['an Authorization header', { Authorization: 'Basic ZGVtbzpzM2NyZXQ=' }],
    ['a lowercase authorization header', { authorization: 'Basic ZGVtbzpzM2NyZXQ=' }],
    ['apiKey', { apiKey: 'sk-live-1234567890' }],
    ['api_key', { api_key: 'sk-live-1234567890' }],
    ['api-key', { 'api-key': 'sk-live-1234567890' }],
    ['APIKEY', { APIKEY: 'sk-live-1234567890' }],
    ['a bearer token in a value', { proxy: 'Bearer eyJhbGciOiJIUzI1NiJ9.x' }],
  ])('redacts %s before transmission', (_label, field) => {
    const safe = safety.metadata(field, 'metadata');

    expect(Object.values(safe ?? {})).toStrictEqual([REDACTED]);
    expect(JSON.stringify(safe)).not.toContain('ZGVtbzpzM2NyZXQ=');
    expect(JSON.stringify(safe)).not.toContain('sk-live-1234567890');
    expect(JSON.stringify(safe)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts at any depth, and only the matching key', () => {
    const safe = safety.metadata(
      { request: { headers: { Authorization: 'Bearer secret-value', accept: '*/*' } } },
      'metadata',
    );

    expect(safe).toStrictEqual({
      request: { headers: { Authorization: REDACTED, accept: '*/*' } },
    });
  });

  it('leaves a credential-adjacent but harmless field alone', () => {
    // CLAUDE.md ## Product claims: false positives are the failure mode that kills this
    // product. §15 names three shapes; a fourth invented here would delete real evidence.
    const safe = safety.metadata(
      { passwordPolicy: 'min 8 chars', tokenBudget: 4096, description: 'bears are large' },
      'metadata',
    );

    expect(safe).toStrictEqual({
      passwordPolicy: 'min 8 chars',
      tokenBudget: 4096,
      description: 'bears are large',
    });
  });

  it('runs a caller hook first and the shipped defaults after it', () => {
    const seen: Array<[unknown, string]> = [];
    const redact: Redactor = (value, path) => {
      seen.push([value, path]);
      return path.endsWith('.ssn') ? '[MINE]' : value;
    };

    const safe = createPayloadSafety({ redact }).metadata(
      { ssn: '111-22-3333', apiKey: 'sk-live-1' },
      'metadata',
    );

    // The hook saw the ORIGINAL apiKey — it runs before the defaults, so a caller can still
    // inspect. The default then replaced it, so the caller cannot un-redact by accident.
    expect(seen).toContainEqual(['sk-live-1', 'metadata.apiKey']);
    expect(safe).toStrictEqual({ ssn: '[MINE]', apiKey: REDACTED });
  });

  it('fails closed when a caller hook throws', () => {
    const safe = createPayloadSafety({
      redact: () => {
        throw new Error('hook exploded');
      },
    }).metadata({ note: 'harmless' }, 'metadata');

    // §16 forbids a redaction failure from throwing; a redactor whose behaviour is unknown
    // must not fall back to "ship the original". The hook throws on the FIRST node — the
    // whole record — so the whole record is replaced.
    expect(safe).toStrictEqual({ [REPLACED_KEY]: REDACTED });
    expect(JSON.stringify(safe)).not.toContain('harmless');
  });

  it('exposes the default redactor so a caller can see the floor beneath their hook', () => {
    expect(defaultRedactor('Bearer abc', 'input.header')).toBe(REDACTED);
    expect(defaultRedactor('plain', 'input.header')).toBe('plain');
  });
});

describe('§15 size cap — 32KB per field, truncate and flag', () => {
  it('states §15s default', () => {
    expect(DEFAULT_MAX_FIELD_BYTES).toBe(32 * 1024);
  });

  it('leaves a field under the cap byte-identical and unflagged', () => {
    const small = { note: 'x'.repeat(100) };
    const io = safety.toolIO(small, null);

    expect(io.input).toStrictEqual(small);
    expect(io.inputTruncated).toBe(false);
    expect(io.inputBytes).toBe(measure(small));
  });

  it('truncates a 1MB tool output, flags it, and keeps the measurement', () => {
    const oneMegabyte = 'y'.repeat(1024 * 1024);
    const io = safety.toolIO(null, oneMegabyte);

    expect(io.outputTruncated).toBe(true);
    // The measurement is of the ORIGINAL, sourced here by measuring it independently.
    expect(io.outputBytes).toBe(measure(oneMegabyte));
    expect(io.outputBytes).toBeGreaterThan(1_000_000);
    // What ships is inside the cap. §15: "Never silently store a 4MB blob."
    expect(measure(io.output)).toBeLessThanOrEqual(32 * 1024);
    expect(String(io.output)).toContain('[truncated]');
  });

  it('keeps as many real keys as fit and marks the record as truncated', () => {
    const wide: Record<string, string> = {};
    for (let index = 0; index < 5_000; index += 1) wide[`key${index}`] = 'v'.repeat(64);

    const safe = safety.metadata(wide, 'metadata');

    expect(measure(safe)).toBeLessThanOrEqual(32 * 1024);
    expect(safe?.[TRUNCATION_KEY]).toBe(true);
    expect(safe?.key0).toBe('v'.repeat(64));
    expect(Object.keys(safe ?? {}).length).toBeGreaterThan(10);
    expect(Object.keys(safe ?? {}).length).toBeLessThan(5_000);
  });

  it('keeps a prefix of a long array and says how many it dropped', () => {
    const long = Array.from({ length: 20_000 }, (_value, index) => ({ index }));
    const io = safety.toolIO(long, null);

    expect(measure(io.input)).toBeLessThanOrEqual(32 * 1024);
    expect(Array.isArray(io.input)).toBe(true);
    expect((io.input as unknown[])[0]).toStrictEqual({ index: 0 });
    expect(String((io.input as unknown[]).at(-1))).toMatch(/^\[truncated: \d+ more item\(s\)\]$/);
  });

  it('flags a value the walk elided even when the bytes never reached the cap', () => {
    // 20 000 tiny objects serialize to well under 32KB, so the byte cap never fires. The
    // walk's own item bound still drops 19 000 of them, and a dropped item with
    // `inputTruncated: false` beside it would be a silent loss.
    const long = Array.from({ length: 20_000 }, (_value, index) => ({ index }));
    const sanitizedBytes = measure(safety.toolIO(long, null).input);
    const io = safety.toolIO(long, null);

    expect(sanitizedBytes).toBeLessThan(32 * 1024);
    expect(io.inputTruncated).toBe(true);
    expect((io.input as unknown[]).length).toBeLessThan(20_000);
  });

  it('honours a caller-lowered cap', () => {
    const lowered = createPayloadSafety({ maxFieldBytes: 512 });
    const io = lowered.toolIO('z'.repeat(4_000), null);

    expect(io.inputTruncated).toBe(true);
    expect(measure(io.input)).toBeLessThanOrEqual(512);
  });

  it('never cuts a surrogate pair in half', () => {
    const emoji = '🙂'.repeat(20_000);
    const io = safety.toolIO(emoji, null);
    const shipped = String(io.input);

    expect(io.inputTruncated).toBe(true);
    expect(measure(shipped)).toBeLessThanOrEqual(32 * 1024);
    // A lone surrogate survives JSON.stringify but is not valid text; encode/decode would
    // replace it with U+FFFD.
    expect(new TextDecoder().decode(encoder.encode(shipped))).toBe(shipped);
    expect(shipped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('§15 captureToolIO — the opt-out', () => {
  it('drops input and output entirely while the flags stay honest, and reports the bytes as unmeasured, not zero', () => {
    // S3 (Reviewer, Phase 4 phase gate repair attempt 1). Before this the not-captured
    // branch reported `inputBytes: 0` / `outputBytes: 0` — indistinguishable from a real
    // call whose sanitized value genuinely measured zero bytes, and the Dashboard rendered
    // it as "0 bytes lost to truncation" for a run whose tool IO was never measured at all
    // (`CLAUDE.md` ## Product claims). `null` is the honest "not reported" state.
    const opted = createPayloadSafety({ captureToolIO: false });
    const io = opted.toolIO({ apiKey: 'sk-live-1' }, 'a very long output');

    expect(opted.captureToolIO).toBe(false);
    expect(io).toStrictEqual({
      input: null,
      output: null,
      inputTruncated: false,
      outputTruncated: false,
      inputBytes: null,
      outputBytes: null,
    });

    // Distinguishable from a real, captured zero: a genuinely empty value still measures 0.
    const captured = createPayloadSafety().toolIO('', '');
    expect(captured.inputBytes).toBe(2); // `""` sanitizes/stringifies to `""`, 2 bytes.
    expect(captured.inputBytes).not.toBeNull();
  });

  it('captures by default', () => {
    expect(createPayloadSafety().captureToolIO).toBe(true);
  });
});

describe('§15 fingerprints — over sanitized, canonicalized data', () => {
  it('is stable across key order', () => {
    expect(fingerprintOf({ a: 1, b: 2 })).toBe(fingerprintOf({ b: 2, a: 1 }));
  });

  it('is stable across two structurally identical values', () => {
    expect(fingerprintOf({ tool: 'search', args: [1, 2] })).toBe(
      fingerprintOf({ args: [1, 2], tool: 'search' }),
    );
  });

  it('separates values that differ', () => {
    expect(fingerprintOf({ query: 'bears' })).not.toBe(fingerprintOf({ query: 'wolves' }));
  });

  it('is order-sensitive inside an array, which is information', () => {
    expect(fingerprintOf([1, 2])).not.toBe(fingerprintOf([2, 1]));
  });

  it('never fingerprints a raw secret', () => {
    // §15: "Fingerprints are computed over sanitized, canonicalized data. Never fingerprint
    // raw secrets." Two different secrets under a redacted key must be INDISTINGUISHABLE —
    // if they were not, the fingerprint would be an oracle for the secret.
    expect(fingerprintOf({ apiKey: 'sk-live-AAAA' })).toBe(
      fingerprintOf({ apiKey: 'sk-live-BBBB' }),
    );
    expect(fingerprintOf({ apiKey: 'sk-live-AAAA', q: 'x' })).not.toBe(
      fingerprintOf({ apiKey: 'sk-live-AAAA', q: 'y' }),
    );
  });

  it('survives the same hostile values the serializer does', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;

    expect(() => fingerprintOf(cyclic)).not.toThrow();
    expect(fingerprintOf(cyclic)).toMatch(/^[0-9a-f]{16}$/);
  });
});
