import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock';
import { STALE_THRESHOLD_MS } from './stale-threshold.provider';
import type { RunRecord, StepRecord } from './run-record';
import { RunsRepository } from './runs.repository';
import { deriveRunViewStatus } from './stale';
import type {
  RunDetailView,
  RunListView,
  RunSummaryView,
  RunsListQuery,
  StepView,
} from '@lengentic/shared/read';

/**
 * Reads runs. The only place the derived/stored status split is resolved.
 *
 * `now` and the threshold arrive as constructor arguments rather than being read from
 * `Date.now()` and `ConfigService` inside the methods. That is what lets the thirty-minute
 * boundary be tested exactly instead of slept through, and it keeps `deriveRunViewStatus` a
 * pure function of its inputs.
 */
@Injectable()
export class RunsService {
  constructor(
    private readonly repository: RunsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STALE_THRESHOLD_MS) private readonly staleThresholdMs: number,
  ) {}

  /**
   * One page of runs, newest first.
   *
   * `hasMore` is answered by asking for one row more than the page and reporting whether it
   * came back. The alternative — `COUNT(*)` on every list request — costs a second scan to
   * answer a question the caller only needs a boolean for, and `records.length === limit` is
   * simply wrong on the exact last page.
   */
  async list(query: RunsListQuery): Promise<RunListView> {
    // A single clock reading for the whole page. Reading it per run would let two runs with
    // identical `lastEventAt` land on opposite sides of the threshold within one response.
    const now = this.clock.now();

    const records = await this.repository.listRuns(query.limit + 1, query.offset);
    const page = records.slice(0, query.limit);

    return {
      runs: page.map((record) => this.toRunSummaryView(record, now)),
      limit: query.limit,
      offset: query.offset,
      hasMore: records.length > query.limit,
    };
  }

  /**
   * One run and every step recorded against it.
   *
   * `undefined` rather than a thrown 404: whether a missing run is an error is a transport
   * decision, and this service is also the seam a future analysis reader would call.
   */
  async findById(id: string): Promise<RunDetailView | undefined> {
    const now = this.clock.now();

    const record = await this.repository.findRun(id);
    if (record === undefined) return undefined;

    const steps = await this.repository.listSteps(id);

    return {
      ...this.toRunSummaryView(record, now),
      steps: steps.map(toStepView),
    };
  }

  private toRunSummaryView(record: RunRecord, now: Date): RunSummaryView {
    return {
      id: record.id,
      traceId: record.traceId,
      workflowName: record.workflowName,
      workflowVersion: record.workflowVersion,
      status: deriveRunViewStatus({
        storedStatus: record.status,
        lastEventAt: record.lastEventAt,
        now,
        staleThresholdMs: this.staleThresholdMs,
      }),
      startedAt: toIsoOrNull(record.startedAt),
      completedAt: toIsoOrNull(record.completedAt),
      receivedAt: record.receivedAt.toISOString(),
      lastEventAt: record.lastEventAt.toISOString(),
      metadata: record.metadata,
    };
  }
}

function toIsoOrNull(instant: Date | null): string | null {
  return instant === null ? null : instant.toISOString();
}

/**
 * A Step reports its STORED status — see the note on `StepViewSchema`. There is no clock
 * argument here on purpose: nothing about a step is time-derived, and a parameter that is
 * accepted and ignored is an invitation to derive one later.
 */
function toStepView(record: StepRecord): StepView {
  return {
    id: record.id,
    runId: record.runId,
    parentStepId: record.parentStepId,
    name: record.name,
    agentName: record.agentName,
    type: record.type,
    status: record.status,
    startedAt: toIsoOrNull(record.startedAt),
    completedAt: toIsoOrNull(record.completedAt),
    receivedAt: record.receivedAt.toISOString(),
    metadata: record.metadata,
  };
}
