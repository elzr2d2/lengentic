import { describe, expect, it } from 'vitest';

import {
  EVENT_LEVEL_ERROR_CODES,
  IdSchema,
  INGEST_ERROR_CODES,
  INGEST_LIMITS,
  IngestResultErrorSchema,
  IngestResultStatusSchema,
  REQUEST_ERROR_CODES,
  TELEMETRY_EVENT_TYPES,
  TELEMETRY_INGEST_PATH,
  TELEMETRY_PAYLOAD_SCHEMAS,
  TELEMETRY_SCHEMA_VERSION,
} from '../../index';
import type { IngestResultError } from '../../index';

// Expected values below are transcribed from MVP_PLAN_V3.md and
// docs/decisions/0005-phase-2-wire-contract-gaps.md, never read off the package under
// test. If the two disagree, one of these assertions must fail.

describe('public entry — literals from the plan', () => {
  it('TELEMETRY_EVENT_TYPES is exactly the four §12/ADR-0005 members, in order', () => {
    expect(TELEMETRY_EVENT_TYPES).toEqual([
      'run.started',
      'run.completed',
      'step.started',
      'step.completed',
    ]);
    expect(new Set(TELEMETRY_EVENT_TYPES).size).toBe(4);
  });

  it('TELEMETRY_SCHEMA_VERSION is "1" (§12:474)', () => {
    expect(TELEMETRY_SCHEMA_VERSION).toBe('1');
  });

  it('INGEST_LIMITS matches §12:527-529 / OD-2 verbatim, and is frozen', () => {
    expect(INGEST_LIMITS).toEqual({
      maxEventsPerBatch: 500,
      maxRequestBodyBytes: 5242880,
      maxEventPayloadBytes: 65536,
    });
    expect(Object.isFrozen(INGEST_LIMITS)).toBe(true);
  });

  it('every TelemetryEventType has exactly one registered payload schema, no orphans', () => {
    expect(Object.keys(TELEMETRY_PAYLOAD_SCHEMAS)).toEqual(TELEMETRY_EVENT_TYPES);
  });

  it('INGEST_ERROR_CODES is the four §12 codes plus ADR-0006 EVENT_TOO_LARGE, and is frozen', () => {
    expect(INGEST_ERROR_CODES).toEqual({
      UNSUPPORTED_SCHEMA_VERSION: 'UNSUPPORTED_SCHEMA_VERSION',
      UNKNOWN_EVENT_TYPE: 'UNKNOWN_EVENT_TYPE',
      MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
      INVALID_PAYLOAD: 'INVALID_PAYLOAD',
      EVENT_TOO_LARGE: 'EVENT_TOO_LARGE',
    });
    expect(Object.isFrozen(INGEST_ERROR_CODES)).toBe(true);
  });

  it('IngestResultStatusSchema accepts ACCEPTED/DUPLICATE/REJECTED and rejects "OK" (§12:556)', () => {
    expect(IngestResultStatusSchema.safeParse('ACCEPTED').success).toBe(true);
    expect(IngestResultStatusSchema.safeParse('DUPLICATE').success).toBe(true);
    expect(IngestResultStatusSchema.safeParse('REJECTED').success).toBe(true);
    expect(IngestResultStatusSchema.safeParse('OK').success).toBe(false);
  });

  it('TELEMETRY_INGEST_PATH is "/v1/telemetry/events" (§12:567)', () => {
    expect(TELEMETRY_INGEST_PATH).toBe('/v1/telemetry/events');
  });

  it('IdSchema rejects the empty string — the IngestResult.eventId sentinel depends on this', () => {
    expect(IdSchema.safeParse('').success).toBe(false);
  });

  it('IngestResultError is exported beside IngestResultErrorSchema, per README.md:28-29', () => {
    // Compile-time check: consumers must never need a direct zod import to name this
    // shape. If IngestResultError stops being exported from the public entry, this file
    // fails to typecheck.
    const parsed = IngestResultErrorSchema.parse({ code: 'X', message: 'm' });
    const typed: IngestResultError = parsed;
    expect(typed).toEqual({ code: 'X', message: 'm' });
  });
});

describe('event-level vs request-level rejection classification (S3 / ADR 0006)', () => {
  it('EVENT_LEVEL_ERROR_CODES and REQUEST_ERROR_CODES never share a code', () => {
    const eventCodes: ReadonlySet<string> = new Set(EVENT_LEVEL_ERROR_CODES);
    const requestCodes = Object.values(REQUEST_ERROR_CODES);
    for (const code of requestCodes) {
      expect(eventCodes.has(code)).toBe(false);
    }
  });

  it('EVENT_TOO_LARGE is event-level, per ADR 0006 — not request-level', () => {
    expect(EVENT_LEVEL_ERROR_CODES).toContain('EVENT_TOO_LARGE');
    expect(Object.values(REQUEST_ERROR_CODES)).not.toContain('EVENT_TOO_LARGE');
  });

  it('EVENT_LEVEL_ERROR_CODES is exactly INGEST_ERROR_CODES, frozen', () => {
    expect([...EVENT_LEVEL_ERROR_CODES].sort()).toEqual(Object.values(INGEST_ERROR_CODES).sort());
    expect(Object.isFrozen(EVENT_LEVEL_ERROR_CODES)).toBe(true);
  });

  it("REQUEST_ERROR_CODES is §12:531-534's three request-level rejections, frozen", () => {
    expect(REQUEST_ERROR_CODES).toEqual({
      BODY_TOO_LARGE: 'BODY_TOO_LARGE',
      INVALID_JSON: 'INVALID_JSON',
      INVALID_BATCH: 'INVALID_BATCH',
    });
    expect(Object.isFrozen(REQUEST_ERROR_CODES)).toBe(true);
  });
});
