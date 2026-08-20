import type { Metadata, RunStatus } from '@lengentic/shared';

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
