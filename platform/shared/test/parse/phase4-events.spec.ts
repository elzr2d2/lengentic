import { describe, expect, it } from 'vitest';

import { parseTelemetryEvent } from '../../index';

// The five types ADR 0005 decision 3 deferred to Phase 4, and the schemaVersion bump that
// carries them. Negative fixtures first (CLAUDE.md ## Product claims): the failure mode that
// matters here is a payload the contract accepts and the database cannot hold.

const ENVELOPE_V2 = {
  eventId: 'evt-1',
  schemaVersion: '2',
  entityId: 'dec-1',
  runId: 'run-1',
  occurredAt: '2026-08-30T10:00:00Z',
};

const DECISION_RECORDED = {
  ...ENVELOPE_V2,
  type: 'decision.recorded',
  payload: {
    stepId: 'step-1',
    decisionType: 'execution_strategy',
    contextKey: 'risk:low|tasks:2-3|deps:none|conflict:absent|validation:ready',
    contextKeyVersion: 'v1',
    rawContext: { riskBucket: 'low', taskCount: 3 },
    availableOptions: ['sequential', 'parallel'],
    selectedOption: 'sequential',
  },
};

const OUTCOME_ATTESTED = {
  ...ENVELOPE_V2,
  type: 'decision.outcome_attested',
  payload: { outcome: 'SUCCESS', observedAt: '2026-08-30T11:00:00Z' },
};

const MODEL_CALL = {
  ...ENVELOPE_V2,
  entityId: 'mc-1',
  type: 'model_call.recorded',
  payload: {
    stepId: 'step-1',
    provider: 'anthropic',
    model: 'claude-opus-5',
    latencyMs: 1200,
    inputTokens: 400,
    outputTokens: 120,
    status: 'ok',
    metadata: null,
  },
};

const TOOL_CALL = {
  ...ENVELOPE_V2,
  entityId: 'tc-1',
  type: 'tool_call.recorded',
  payload: {
    stepId: 'step-1',
    toolName: 'read_file',
    input: { path: 'a.ts' },
    output: 'contents',
    inputTruncated: false,
    outputTruncated: false,
    inputBytes: 17,
    outputBytes: 8,
    startedAt: '2026-08-30T10:00:00Z',
    completedAt: '2026-08-30T10:00:01Z',
    durationMs: 1000,
    success: true,
    error: null,
  },
};

const ERROR_RECORDED = {
  ...ENVELOPE_V2,
  entityId: 'err-1',
  type: 'error.recorded',
  payload: { stepId: 'step-1', type: 'TimeoutError', message: 'tool timed out', metadata: null },
};

const ALL_V2_EVENTS = [
  ['decision.recorded', DECISION_RECORDED],
  ['decision.outcome_attested', OUTCOME_ATTESTED],
  ['model_call.recorded', MODEL_CALL],
  ['tool_call.recorded', TOOL_CALL],
  ['error.recorded', ERROR_RECORDED],
] as const;

describe('the schemaVersion bump gates the new types (ADR 0005 decision 3)', () => {
  it.each(ALL_V2_EVENTS)('rejects %s at schemaVersion "1"', (_name, event) => {
    const result = parseTelemetryEvent({ ...event, schemaVersion: '1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNKNOWN_EVENT_TYPE');
  });

  it.each(ALL_V2_EVENTS)('accepts %s at schemaVersion "2"', (name, event) => {
    const result = parseTelemetryEvent(event);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.type).toBe(name);
  });

  it('still accepts the Phase 2 types at BOTH versions — the bump retires no old event', () => {
    const runStarted = {
      eventId: 'evt-9',
      type: 'run.started',
      entityId: 'run-1',
      runId: 'run-1',
      occurredAt: '2026-08-30T10:00:00Z',
      payload: { workflowName: 'wf', workflowVersion: 'v1' },
    };
    expect(parseTelemetryEvent({ ...runStarted, schemaVersion: '1' }).ok).toBe(true);
    expect(parseTelemetryEvent({ ...runStarted, schemaVersion: '2' }).ok).toBe(true);
  });
});

describe('decision.recorded — §13/§14', () => {
  it('accepts a decision with NO contextKey — §14 stores it and excludes it from aggregation', () => {
    const { contextKey: _k, contextKeyVersion: _v, ...payload } = DECISION_RECORDED.payload;
    const result = parseTelemetryEvent({ ...DECISION_RECORDED, payload });
    expect(result.ok).toBe(true);
    // The decision must survive. Rejecting it would lose the selection too, and §14 only
    // excludes it from aggregation.
    if (result.ok && result.event.type === 'decision.recorded') {
      expect(result.event.payload.selectedOption).toBe('sequential');
      expect(result.event.payload.contextKey ?? null).toBeNull();
    }
  });

  it('rejects a decision with no decisionType — the analysis has nothing to group', () => {
    const { decisionType: _d, ...payload } = DECISION_RECORDED.payload;
    const result = parseTelemetryEvent({ ...DECISION_RECORDED, payload });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_PAYLOAD');
  });

  it('rejects a decision with no stepId — nullable in Prisma only for attestation-first', () => {
    const { stepId: _s, ...payload } = DECISION_RECORDED.payload;
    expect(parseTelemetryEvent({ ...DECISION_RECORDED, payload }).ok).toBe(false);
  });

  it('rejects an empty availableOptions — a choice between nothing is not a decision', () => {
    const result = parseTelemetryEvent({
      ...DECISION_RECORDED,
      payload: { ...DECISION_RECORDED.payload, availableOptions: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_PAYLOAD');
  });

  it('rejects availableOptions that is not an array of names', () => {
    expect(
      parseTelemetryEvent({
        ...DECISION_RECORDED,
        payload: { ...DECISION_RECORDED.payload, availableOptions: 'sequential' },
      }).ok,
    ).toBe(false);
  });
});

describe('decision.outcome_attested — §14', () => {
  it('accepts an attestation with no observedAt — §14 makes it optional', () => {
    const result = parseTelemetryEvent({
      ...OUTCOME_ATTESTED,
      payload: { outcome: 'FAILURE' },
    });
    expect(result.ok).toBe(true);
  });

  it.each(['SUCCESS', 'FAILURE', 'UNKNOWN'])('accepts outcome %s', (outcome) => {
    expect(parseTelemetryEvent({ ...OUTCOME_ATTESTED, payload: { outcome } }).ok).toBe(true);
  });

  it('rejects an outcome outside the §13 vocabulary', () => {
    const result = parseTelemetryEvent({ ...OUTCOME_ATTESTED, payload: { outcome: 'PARTIAL' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_PAYLOAD');
  });

  it('rejects a caller-supplied outcomeAttestedBy — §14 gives the caller no such choice', () => {
    // The field is not on the schema, so a caller sending it is sending an unknown key.
    // z.object strips unknown keys rather than failing, so the assertion is that the value
    // does NOT survive onto the parsed event — it can never reach the persistence edge.
    const result = parseTelemetryEvent({
      ...OUTCOME_ATTESTED,
      payload: { outcome: 'SUCCESS', outcomeAttestedBy: 'INFERRED' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.payload).not.toHaveProperty('outcomeAttestedBy');
  });
});

describe('model_call.recorded — §13', () => {
  it('accepts a call with neither token count — §13 marks exactly those two optional', () => {
    const { inputTokens: _i, outputTokens: _o, ...payload } = MODEL_CALL.payload;
    expect(parseTelemetryEvent({ ...MODEL_CALL, payload }).ok).toBe(true);
  });

  it('rejects a negative latencyMs', () => {
    expect(
      parseTelemetryEvent({ ...MODEL_CALL, payload: { ...MODEL_CALL.payload, latencyMs: -1 } }).ok,
    ).toBe(false);
  });

  it('rejects a fractional token count', () => {
    expect(
      parseTelemetryEvent({ ...MODEL_CALL, payload: { ...MODEL_CALL.payload, inputTokens: 1.5 } })
        .ok,
    ).toBe(false);
  });

  it('accepts any status string — §13 leaves the vocabulary unenumerated', () => {
    expect(
      parseTelemetryEvent({ ...MODEL_CALL, payload: { ...MODEL_CALL.payload, status: 'refusal' } })
        .ok,
    ).toBe(true);
  });
});

describe('tool_call.recorded — §13/§15', () => {
  it('accepts a null input and output — "no input" is a legitimate tool shape', () => {
    const result = parseTelemetryEvent({
      ...TOOL_CALL,
      payload: { ...TOOL_CALL.payload, input: null, output: null, inputBytes: 0, outputBytes: 0 },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a non-object input — a bare string or array is a legitimate tool shape', () => {
    expect(
      parseTelemetryEvent({ ...TOOL_CALL, payload: { ...TOOL_CALL.payload, input: 'a.ts' } }).ok,
    ).toBe(true);
  });

  it('rejects a missing inputTruncated — an omitted flag would read as "not truncated"', () => {
    const { inputTruncated: _t, ...payload } = TOOL_CALL.payload;
    const result = parseTelemetryEvent({ ...TOOL_CALL, payload });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_PAYLOAD');
  });

  it('accepts a missing byte count when the call was never truncated (S3, Phase 4 phase gate repair attempt 1) — "not captured", not "measured zero"', () => {
    // Reviewer S3: `captureToolIO: false` has nothing to measure at all, and a required
    // field forced the SDK to send a manufactured `0` — which the Dashboard then rendered as
    // a real "0 bytes lost to truncation" for a run whose tool IO was never captured
    // (`CLAUDE.md` ## Product claims). `inputBytes`/`outputBytes` are `.nullish()` for
    // exactly that reason; this test used to pin the opposite (a missing count was
    // REJECTED), which is the defect S3 closes, not a property still worth protecting.
    // `TOOL_CALL.payload.inputTruncated` is `false`, which is what makes this "not
    // captured" rather than the malformed state the two tests below reject.
    const { inputBytes: _b, ...payload } = TOOL_CALL.payload;
    const result = parseTelemetryEvent({ ...TOOL_CALL, payload });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.event.payload as { inputBytes?: number | null }).inputBytes).toBeUndefined();
    }
  });

  it('rejects a missing inputTruncated even when inputBytes is also absent — the two are independent requirements', () => {
    // Guards against a fix for the test above accidentally loosening `inputTruncated` too:
    // §15's flag is still required verbatim (the sibling test above pins that on its own),
    // and dropping BOTH together must still fail on the flag, not silently succeed.
    const { inputTruncated: _t, inputBytes: _b, ...payload } = TOOL_CALL.payload;
    const result = parseTelemetryEvent({ ...TOOL_CALL, payload });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_PAYLOAD');
  });

  it('rejects inputTruncated: true with inputBytes absent — the narrowed invariant Reviewer B2 / Tester F3 restore (Phase 4 phase gate repair attempt 2)', () => {
    // Attempt 1's unconditional `.nullish()` let this exact combination through: a call
    // reported as truncated with no byte count at all, which the Dashboard then rendered as
    // "1 tool input truncated" beside "0 bytes lost to truncation" — a manufactured zero for
    // a quantity the system never received. `captureToolIO: false` (the only legitimate
    // reason bytes go unreported) also forces `inputTruncated: false`
    // (`payload-safety.ts`'s `toolIO`), so a call that WAS truncated always has a real count
    // to report; absent here is a malformed claim, not "not captured".
    const { inputBytes: _b, ...payload } = TOOL_CALL.payload;
    const result = parseTelemetryEvent({
      ...TOOL_CALL,
      payload: { ...payload, inputTruncated: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_PAYLOAD');
  });

  it('rejects outputTruncated: true with outputBytes absent — symmetric with inputBytes', () => {
    const { outputBytes: _b, ...payload } = TOOL_CALL.payload;
    const result = parseTelemetryEvent({
      ...TOOL_CALL,
      payload: { ...payload, outputTruncated: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_PAYLOAD');
  });

  it('accepts inputTruncated: true when inputBytes is a real measurement — the pairing, not the flag alone, is what is enforced', () => {
    const result = parseTelemetryEvent({
      ...TOOL_CALL,
      payload: { ...TOOL_CALL.payload, inputTruncated: true, inputBytes: 65_536 },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a failed call carrying an error message', () => {
    expect(
      parseTelemetryEvent({
        ...TOOL_CALL,
        payload: { ...TOOL_CALL.payload, success: false, error: 'ENOENT' },
      }).ok,
    ).toBe(true);
  });
});

describe('error.recorded — §13', () => {
  it('accepts an empty message — uninformative is not malformed, and type/stepId still locate it', () => {
    expect(
      parseTelemetryEvent({
        ...ERROR_RECORDED,
        payload: { ...ERROR_RECORDED.payload, message: '' },
      }).ok,
    ).toBe(true);
  });

  it('accepts a message far longer than any VarChar bound — an error is captured evidence', () => {
    const result = parseTelemetryEvent({
      ...ERROR_RECORDED,
      payload: { ...ERROR_RECORDED.payload, message: 'x'.repeat(5000) },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.event.type === 'error.recorded') {
      expect(result.event.payload.message).toHaveLength(5000);
    }
  });

  it('rejects a missing type', () => {
    const { type: _t, ...payload } = ERROR_RECORDED.payload;
    expect(parseTelemetryEvent({ ...ERROR_RECORDED, payload }).ok).toBe(false);
  });
});
