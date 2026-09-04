import type {
  DecisionRecord as EngineDecisionRecord,
  Outcome as EngineOutcome,
  OutcomeAttestedBy as EngineOutcomeAttestedBy,
} from '@lengentic/analysis-engine';
import type { DecisionOutcome, RunStatus } from '@lengentic/shared';
import type { OutcomeAttestedBy } from '@lengentic/shared/read';

import { deriveRunViewStatus } from '../runs/stale';

/**
 * One `Decision` row, plus the three `Run` columns §18's group key and §39's STALE rule need,
 * on the API's side of the persistence edge (`docs/ENGINEERING_STANDARDS.md` DATA-1).
 *
 * `Decision` has no foreign key to `Run` (`schema.prisma`: a decision event may arrive before
 * its run's start event), so the workflow fields are carried here rather than reached for
 * through a relation. They are nullable for the same arrival-order reason `Run.workflowName`
 * is: null means "the start event has not landed yet".
 */
export interface AnalysisDecisionSource {
  readonly decisionId: string;
  readonly runId: string;
  /** The STORED run status. Never `STALE` — that is derived here, per ADR 0005 decision 4. */
  readonly runStatus: RunStatus;
  /** Server clock (§13). The sole input to the derived STALE read besides `now`. */
  readonly runLastEventAt: Date;
  readonly workflowName: string | null;
  readonly workflowVersion: string | null;
  readonly decisionType: string | null;
  readonly contextKey: string | null;
  readonly contextKeyVersion: string | null;
  readonly availableOptions: readonly string[];
  readonly selectedOption: string | null;
  readonly outcome: DecisionOutcome;
  readonly outcomeAttestedBy: OutcomeAttestedBy;
  /** Database clock, `@default(now())`. The only instant every Decision row carries. */
  readonly createdAt: Date;
}

/** The two values the STALE rule needs that are not on a row. Both are inputs, never ambient. */
export interface AnalysisLiveness {
  /** Server clock, read once per analysis run. */
  readonly now: Date;
  readonly staleThresholdMs: number;
}

/**
 * Storage vocabulary → engine vocabulary, written out rather than assigned across.
 *
 * The two enums are identical today, so a direct assignment would compile. It would also
 * keep compiling if the engine grew a fourth `Outcome` the storage side cannot produce, and
 * the reader would have no place to find out. The `switch` is `noFallthroughCasesInSwitch`
 * plus exhaustiveness: add a member on either side and this stops compiling, here, by name.
 */
export function toEngineOutcome(outcome: DecisionOutcome): EngineOutcome {
  switch (outcome) {
    case 'SUCCESS':
      return 'SUCCESS';
    case 'FAILURE':
      return 'FAILURE';
    case 'UNKNOWN':
      return 'UNKNOWN';
  }
}

/** Same reasoning as `toEngineOutcome`. §14 fixes this vocabulary at `CALLER | UNKNOWN`. */
export function toEngineOutcomeAttestedBy(attestedBy: OutcomeAttestedBy): EngineOutcomeAttestedBy {
  switch (attestedBy) {
    case 'CALLER':
      return 'CALLER';
    case 'UNKNOWN':
      return 'UNKNOWN';
  }
}

/**
 * One source row → one engine `DecisionRecord`, or `null` when the row cannot be placed in a
 * §18 group at all.
 *
 * ## Why `null` is a case and not an exclusion count
 *
 * §18 has exactly two exclusion reasons — `staleRun` and `missingContextKey` — and both are
 * counted *within a group*, because both describe a row whose group is known. Four columns
 * are the group's own identity (`workflowName`, `workflowVersion`, `decisionType`,
 * `contextKeyVersion`), and every one of them is nullable on the row: an attestation for an
 * unknown `decisionId` (§14) creates a row with no `decisionType`, and a caller may omit
 * `contextKeyVersion` entirely (`DecisionRecordedPayloadSchema` types it `.nullish()`). A row
 * missing any of them has no group to be excluded *from*, and a sentinel key would invent one
 * — manufacturing a group the caller never had, with a dominance figure computed over rows
 * that share nothing but their gaps. `selectedOption` is the same case one level down: a row
 * that recorded no selection cannot enter a distribution over selections.
 *
 * `contextKey` is deliberately NOT in that list. A null `contextKey` has a group and is §18's
 * `missingContextKey` exclusion, which the engine counts; filtering it here would delete the
 * exclusion count the Dashboard renders.
 */
export function toEngineDecisionRecord(
  source: AnalysisDecisionSource,
  liveness: AnalysisLiveness,
): EngineDecisionRecord | null {
  const { workflowName, workflowVersion, decisionType, contextKeyVersion, selectedOption } = source;

  if (
    workflowName === null ||
    workflowVersion === null ||
    decisionType === null ||
    contextKeyVersion === null ||
    selectedOption === null
  ) {
    return null;
  }

  return {
    decisionId: source.decisionId,
    runId: source.runId,
    runIsStale:
      deriveRunViewStatus({
        storedStatus: source.runStatus,
        lastEventAt: source.runLastEventAt,
        now: liveness.now,
        staleThresholdMs: liveness.staleThresholdMs,
      }) === 'STALE',
    workflowName,
    workflowVersion,
    decisionType,
    contextKey: source.contextKey,
    contextKeyVersion,
    availableOptions: source.availableOptions,
    selectedOption,
    outcome: toEngineOutcome(source.outcome),
    outcomeAttestedBy: toEngineOutcomeAttestedBy(source.outcomeAttestedBy),
  };
}

/** Every source row that can be placed in a §18 group, in the order it was read. */
export function toEngineDecisionRecords(
  sources: readonly AnalysisDecisionSource[],
  liveness: AnalysisLiveness,
): readonly EngineDecisionRecord[] {
  const records: EngineDecisionRecord[] = [];

  for (const source of sources) {
    const record = toEngineDecisionRecord(source, liveness);

    if (record !== null) records.push(record);
  }

  return records;
}

/**
 * §21's `sourceWatermark` — "what data range it was computed over".
 *
 * Analysis is a full recomputation from the beginning of history (§22), so the range has one
 * moving end: its upper bound. That is the newest `Decision.createdAt` the run *read*, not the
 * newest it aggregated — the range describes what was looked at, and a row dropped for a
 * missing group key was still inside the window. `null` when nothing was read, which the
 * caller resolves against its own clock reading; no group can be emitted from no rows, so that
 * value never reaches a persisted recommendation.
 *
 * `createdAt` is the DATABASE clock and is used here as a bound on the data, never in a
 * duration and never compared against a client or application instant — the mix §12 forbids.
 */
export function sourceWatermarkOf(sources: readonly AnalysisDecisionSource[]): Date | null {
  let newest: Date | null = null;

  for (const source of sources) {
    if (newest === null || source.createdAt.getTime() > newest.getTime()) {
      newest = source.createdAt;
    }
  }

  return newest;
}
