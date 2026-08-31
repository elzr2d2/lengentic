import { describe, expect, it } from 'vitest';
import {
  toDecisionRecord,
  toErrorRecord,
  toModelCallRecord,
  toToolCallRecord,
} from './runs.repository';

/**
 * Seam: the persistence edge itself — the four `to*Record` functions, called on a row shape
 * rather than through a database.
 *
 * These are the DATA-1 boundary (`CLAUDE.md` ## Types: no Prisma model ever crosses a module
 * boundary), and one branch inside them is unreachable any other way. `rawContext` and
 * `availableOptions` are `Json` columns, so Postgres will hand back whatever was written —
 * including something a manual `psql` edit put there. The supported ingestion path can only
 * write values that already satisfied the wire contract, so a database-backed test cannot
 * produce a malformed one. It is exercised here because the choice it encodes is a real one:
 * a malformed cell degrades to `null` rather than throwing, so one bad row cannot take down a
 * whole run's detail page.
 *
 * The row literals below are typed only by inference. If a migration renames or retypes a
 * column, `tsc` fails on the call rather than on an assertion — the same compile-time coupling
 * `runs.repository.ts` gets from recovering its row types out of `PrismaClient`.
 */
const CREATED_AT = new Date('2026-08-21T11:00:06.000Z');

function decisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dec-1',
    runId: 'run-1',
    stepId: 'step-a',
    decisionType: 'execution_strategy',
    contextKey: 'risk=low|tasks=2-3',
    contextKeyVersion: 'v1',
    rawContext: { riskBucket: 'low' },
    availableOptions: ['sequential', 'parallel'],
    selectedOption: 'sequential',
    outcome: 'SUCCESS' as const,
    outcomeAttestedBy: 'CALLER' as const,
    outcomeObservedAt: new Date('2026-08-21T11:04:00.000Z'),
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe('toDecisionRecord', () => {
  it('carries a well-formed option list across as an array of strings', () => {
    expect(toDecisionRecord(decisionRow()).availableOptions).toStrictEqual([
      'sequential',
      'parallel',
    ]);
  });

  it('reports a null option list as null and not as an empty list', () => {
    // §14's attestation-first row has no options at all. `[]` would say "this decision
    // offered no options", which is a different and false claim about a decision the caller
    // may well have recorded elsewhere.
    expect(toDecisionRecord(decisionRow({ availableOptions: null })).availableOptions).toBeNull();
  });

  it('degrades a malformed option list to null instead of throwing', () => {
    // A `Json` column can hold anything. Throwing here would take down the whole run detail
    // page for one bad cell; `null` loses the options and keeps the decision.
    expect(
      toDecisionRecord(decisionRow({ availableOptions: { not: 'an array' } })).availableOptions,
    ).toBeNull();
    expect(toDecisionRecord(decisionRow({ availableOptions: [1, 2] })).availableOptions).toBeNull();
  });

  it('carries a null contextKey across as null, never as a default key', () => {
    // §14, and the reason the whole product has a `contextKey` at all: a keyless decision is
    // "stored but EXCLUDED from aggregation", because "silent inclusion under a default key
    // is how fake dominance gets manufactured". A mapper that substituted anything here would
    // put every keyless decision from every caller into one bucket and let it dominate.
    //
    // Pinned at THIS level and not only at the service, where the repository is a fake: a
    // substitution introduced in this function is invisible to every service-level test.
    const record = toDecisionRecord(decisionRow({ contextKey: null, contextKeyVersion: null }));

    expect(record.contextKey).toBeNull();
    expect(record.contextKeyVersion).toBeNull();
  });

  it('degrades a non-object rawContext to null instead of throwing', () => {
    expect(toDecisionRecord(decisionRow({ rawContext: 'not-an-object' })).rawContext).toBeNull();
  });

  it('preserves the attestation triple, which is what makes the rate an attested one', () => {
    const record = toDecisionRecord(decisionRow({ outcome: 'FAILURE' as const }));

    expect(record.outcome).toBe('FAILURE');
    expect(record.outcomeAttestedBy).toBe('CALLER');
    expect(record.outcomeObservedAt).toStrictEqual(new Date('2026-08-21T11:04:00.000Z'));
  });
});

describe('toModelCallRecord', () => {
  it('keeps an unreported token count null rather than coercing it to zero', () => {
    const record = toModelCallRecord({
      id: 'mc-1',
      runId: 'run-1',
      stepId: 'step-a',
      provider: 'anthropic',
      model: 'claude-opus-5',
      latencyMs: 812,
      inputTokens: null,
      outputTokens: null,
      status: 'ok',
      metadata: null,
      createdAt: CREATED_AT,
    });

    expect(record.inputTokens).toBeNull();
    expect(record.outputTokens).toBeNull();
    expect(record.latencyMs).toBe(812);
  });
});

describe('toToolCallRecord', () => {
  it('passes a non-object payload through unvalidated, with its truncation measurement', () => {
    // `input`/`output` are the one pair of `Json` columns with nothing to validate against:
    // the wire types them `z.unknown()` because a bare string or an array is a legitimate
    // tool shape, so any schema applied here would blank values ingestion accepted.
    const record = toToolCallRecord({
      id: 'tc-1',
      runId: 'run-1',
      stepId: 'step-a',
      toolName: 'read_file',
      input: 'a bare string',
      output: [1, 2, 3],
      inputTruncated: true,
      outputTruncated: false,
      inputBytes: 1_048_576,
      outputBytes: 3,
      startedAt: new Date('2026-08-21T11:00:08.000Z'),
      completedAt: new Date('2026-08-21T11:00:08.250Z'),
      durationMs: 250,
      success: false,
      error: 'timed out',
    });

    expect(record.input).toBe('a bare string');
    expect(record.output).toStrictEqual([1, 2, 3]);
    expect(record.inputTruncated).toBe(true);
    expect(record.inputBytes).toBe(1_048_576);
    expect(record.error).toBe('timed out');
  });
});

describe('toErrorRecord', () => {
  it('keeps an unbounded message intact — an error message is captured evidence', () => {
    const message = 'x'.repeat(5_000);

    const record = toErrorRecord({
      id: 'err-1',
      runId: 'run-1',
      stepId: 'step-a',
      type: 'ToolExecutionError',
      message,
      metadata: { attempt: 3 },
      createdAt: CREATED_AT,
    });

    expect(record.message).toBe(message);
    expect(record.metadata).toStrictEqual({ attempt: 3 });
  });
});
