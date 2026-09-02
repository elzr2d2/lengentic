import type { DecisionOutcome, Metadata, RunStatus } from '@lengentic/shared';
import type { OutcomeAttestedBy } from '@lengentic/shared/read';

/**
 * What the persistence edge hands back: the domain shape of a Run row, with no Prisma type
 * anywhere in it (`CLAUDE.md` ## Types, `docs/ENGINEERING_STANDARDS.md` DATA-1).
 *
 * Distinct from `RunSummaryView` in two ways that matter, which is why both exist:
 * `status` here is the STORED status and is never `STALE`, and the instants are `Date`s
 * rather than ISO strings — the STALE rule does arithmetic on them, and formatting them for
 * the wire before that arithmetic would mean parsing them back to do it.
 */
export interface RunRecord {
  readonly id: string;
  readonly traceId: string;
  readonly workflowName: string | null;
  readonly workflowVersion: string | null;
  readonly status: RunStatus;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly receivedAt: Date;
  readonly lastEventAt: Date;
  readonly metadata: Metadata | null;

  /**
   * ADR 0014 decision 2 / §16. `null` means no batch for this run has ever reported a drop
   * count — never coerced to `0` (`run-summary.ts`'s `RunSummary.droppedTelemetryEventCount`
   * is the reader that refuses to make that substitution).
   */
  readonly droppedTelemetryEventCount: number | null;
}

/**
 * The same treatment for the four Phase 4 entities: the domain shape of a row, no Prisma
 * type in sight, instants still `Date` rather than ISO strings.
 *
 * `Date` and not a formatted string for the same reason `RunRecord` keeps them — the ISO
 * conversion is the view mapping's job, and a record that arrived pre-formatted would have
 * to be parsed back by anything that ever wanted to compare two of them. Nothing compares
 * them today; the point is that the persistence edge stays the only place the two
 * representations meet.
 */
export interface DecisionRecord {
  readonly id: string;
  readonly runId: string;
  /** Null only on an attestation-first row (§14) — see `DecisionViewSchema`. */
  readonly stepId: string | null;
  readonly decisionType: string | null;
  readonly contextKey: string | null;
  readonly contextKeyVersion: string | null;
  readonly rawContext: Metadata | null;
  readonly availableOptions: readonly string[] | null;
  readonly selectedOption: string | null;
  readonly outcome: DecisionOutcome;
  readonly outcomeAttestedBy: OutcomeAttestedBy;
  readonly outcomeObservedAt: Date | null;
  readonly createdAt: Date;
}

export interface ModelCallRecord {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
  /** Null means the provider reported no usage — never coerced to `0`. §13. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly status: string;
  readonly metadata: Metadata | null;
  readonly createdAt: Date;
}

/** No `createdAt`: §13 gives ToolCall none, and `schema.prisma` adds none. */
export interface ToolCallRecord {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly inputTruncated: boolean;
  readonly outputTruncated: boolean;
  readonly inputBytes: number;
  readonly outputBytes: number;
  /** Client clocks (§13), and `durationMs` is the client's own measurement (§12). */
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly durationMs: number;
  readonly success: boolean;
  readonly error: string | null;
}

export interface ErrorRecord {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly type: string;
  readonly message: string;
  readonly metadata: Metadata | null;
  readonly createdAt: Date;
}

/** The same treatment for a Step row. Step has no `lastEventAt`: liveness is a Run concept. */
export interface StepRecord {
  readonly id: string;
  readonly runId: string;
  readonly parentStepId: string | null;
  readonly name: string | null;
  readonly agentName: string | null;
  readonly type: string | null;
  readonly status: RunStatus;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly receivedAt: Date;
  readonly metadata: Metadata | null;
}
