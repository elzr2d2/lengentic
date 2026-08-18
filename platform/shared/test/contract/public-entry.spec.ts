import { describe, expect, it } from 'vitest';

import {
  IdSchema,
  INGEST_ERROR_CODES,
  INGEST_LIMITS,
  IngestResultStatusSchema,
  TELEMETRY_EVENT_TYPES,
  TELEMETRY_INGEST_PATH,
  TELEMETRY_PAYLOAD_SCHEMAS,
  TELEMETRY_SCHEMA_VERSION,
} from '../../index';

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
});
