import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@lengentic/database';
import { PrismaService } from '../prisma/prisma.service';
import type { CompletionFieldOrigin, EntityMergeState, MergeEntityStatus } from './merge-rules';

// Prisma types never cross this file's boundary outward (CLAUDE.md ## Types) — every public
// method here takes or returns `EntityMergeState` (merge-rules.ts's domain type), never a
// Run/Step row. `RunRow`/`StepRow` are inferred structurally from `PrismaClient` itself
// (`@lengentic/database`'s public surface re-exports only the client type, not its models —
// database/src/index.ts's own header comment), so this mapping cannot silently drift from
// the generated client.
type RunRow = NonNullable<Awaited<ReturnType<PrismaClient['run']['findUnique']>>>;
type StepRow = NonNullable<Awaited<ReturnType<PrismaClient['step']['findUnique']>>>;

/** Start-side fields the Run table actually has named columns for. */
interface RunStartFields {
  readonly workflowName?: string | null;
  readonly workflowVersion?: string | null;
  readonly metadata?: unknown;
}

/** Start-side fields the Step table actually has named columns for. */
interface StepStartFields {
  readonly name?: string | null;
  readonly agentName?: string | null;
  readonly type?: string | null;
  readonly parentStepId?: string | null;
  readonly metadata?: unknown;
}

interface CompletionFields {
  readonly metadata?: unknown;
}

function toOrigins(value: unknown): Readonly<Record<string, CompletionFieldOrigin>> {
  return (value ?? {}) as Readonly<Record<string, CompletionFieldOrigin>>;
}

/**
 * Both Run and Step have exactly one `metadata` column, but `EntityMergeState` carries TWO
 * independent metadata slots (`startFields.metadata`, `completionFields.metadata`) — a
 * schema gap this repository resolves rather than one this packet can fix (schema.prisma
 * sits outside `platform/api/src/**`, this lane's `allowed_paths`).
 *
 * Resolution: the single `metadata` column always holds whichever metadata is CURRENTLY
 * authoritative. Before any completion event has touched the `metadata` key, that is the
 * start event's `metadata`. The moment a completion event writes that key (tracked via
 * `completionFieldOrigins`, exactly as `merge-rules.ts` already tracks every other
 * completion-side key), the column becomes completion-owned and the original start-side
 * value is not separately recoverable — an accepted, documented loss of fidelity in one
 * physical column, not a loss of any field a WIRE response depends on: no Phase 2
 * acceptance criterion reads this column back, and no merge-rules precedence decision
 * depends on it (that decision is driven entirely by `startEventId`/`occurredAt`, which
 * DO have their own columns).
 */
function hasCompletionMetadata(origins: Readonly<Record<string, CompletionFieldOrigin>>): boolean {
  return 'metadata' in origins;
}

@Injectable()
export class TelemetryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async loadRun(id: string): Promise<EntityMergeState | undefined> {
    const row = await this.prisma.client.run.findUnique({ where: { id } });
    return row ? runRowToState(row) : undefined;
  }

  async loadStep(id: string): Promise<EntityMergeState | undefined> {
    const row = await this.prisma.client.step.findUnique({ where: { id } });
    return row ? stepRowToState(row) : undefined;
  }

  /**
   * Upserts the final, already-folded state for one Run. `id` is both the primary key and
   * (per schema.prisma's own note) today's `traceId` — set on create only, never touched by
   * `update`. `receivedAt` is likewise create-only: schema.prisma is explicit that it "is
   * set once, on row creation, and never updated"; only `update`'s payload is reused for
   * both branches, so it must never include `receivedAt`.
   */
  async saveRun(id: string, state: EntityMergeState): Promise<void> {
    const startFields = state.startFields as RunStartFields | null;
    const completionFields = state.completionFields as CompletionFields | null;
    const completionOwnsMetadata = hasCompletionMetadata(state.completionFieldOrigins);

    const columns = {
      status: toRunStatus(state.status),
      startedAt: toDate(state.startedAt),
      completedAt: toDate(state.completedAt),
      lastEventAt: new Date(state.lastEventAt),
      startEventId: state.startEventId,
      completionEventId: state.completionEventId,
      workflowName: startFields?.workflowName ?? null,
      workflowVersion: startFields?.workflowVersion ?? null,
      metadata: toJsonInput(
        completionOwnsMetadata ? completionFields?.metadata : startFields?.metadata,
      ),
      completionFieldOrigins: toJsonInput(state.completionFieldOrigins),
    };

    await this.prisma.client.run.upsert({
      where: { id },
      create: { id, traceId: id, receivedAt: new Date(state.lastEventAt), ...columns },
      update: columns,
    });
  }

  /**
   * Upserts the final, already-folded state for one Step. `runId` is create-only — the
   * table has no FK (§13: a step may arrive before its run), so nothing here validates it
   * against an existing Run row. `receivedAt` is create-only for the same reason as
   * `saveRun`, seeded from `state.lastEventAt` at the moment this row is first created,
   * which is exactly the first event's own `receivedAt` (Step carries no running
   * `lastEventAt` column — schema.prisma: "liveness is a Run concept").
   */
  async saveStep(id: string, runId: string, state: EntityMergeState): Promise<void> {
    const startFields = state.startFields as StepStartFields | null;
    const completionFields = state.completionFields as CompletionFields | null;
    const completionOwnsMetadata = hasCompletionMetadata(state.completionFieldOrigins);

    const columns = {
      status: toRunStatus(state.status),
      startedAt: toDate(state.startedAt),
      completedAt: toDate(state.completedAt),
      startEventId: state.startEventId,
      completionEventId: state.completionEventId,
      name: startFields?.name ?? null,
      agentName: startFields?.agentName ?? null,
      type: startFields?.type ?? null,
      parentStepId: startFields?.parentStepId ?? null,
      metadata: toJsonInput(
        completionOwnsMetadata ? completionFields?.metadata : startFields?.metadata,
      ),
      completionFieldOrigins: toJsonInput(state.completionFieldOrigins),
    };

    await this.prisma.client.step.upsert({
      where: { id },
      create: { id, runId, receivedAt: new Date(state.lastEventAt), ...columns },
      update: columns,
    });
  }
}

function toDate(iso: string | null): Date | null {
  return iso === null ? null : new Date(iso);
}

// Prisma 7's generated `InputJsonValue` has no `undefined` member — `null` is the only
// legal "no value" input for a nullable Json column. `unknown` is cast at this single edge
// because it originates from `EntityMergeState`'s deliberately-opaque `fields` bag
// (merge-rules.ts's own header: callers narrow it, not merge-rules itself).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toJsonInput(value: unknown): any {
  return value === undefined ? null : value;
}

function toRunStatus(status: MergeEntityStatus): RunRow['status'] {
  return status as RunRow['status'];
}

function runRowToState(row: RunRow): EntityMergeState {
  const origins = toOrigins(row.completionFieldOrigins);
  const completionOwnsMetadata = hasCompletionMetadata(origins);

  return {
    entityId: row.id,
    status: row.status as MergeEntityStatus,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    startFields: row.startedAt
      ? {
          workflowName: row.workflowName,
          workflowVersion: row.workflowVersion,
          ...(completionOwnsMetadata ? {} : { metadata: row.metadata }),
        }
      : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    completionFields: row.completedAt
      ? completionOwnsMetadata
        ? { metadata: row.metadata }
        : {}
      : null,
    completionEventId: row.completionEventId,
    startEventId: row.startEventId,
    completionFieldOrigins: origins,
    lastEventAt: row.lastEventAt.getTime(),
  };
}

function stepRowToState(row: StepRow): EntityMergeState {
  const origins = toOrigins(row.completionFieldOrigins);
  const completionOwnsMetadata = hasCompletionMetadata(origins);

  return {
    entityId: row.id,
    status: row.status as MergeEntityStatus,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    startFields: row.startedAt
      ? {
          name: row.name,
          agentName: row.agentName,
          type: row.type,
          parentStepId: row.parentStepId,
          ...(completionOwnsMetadata ? {} : { metadata: row.metadata }),
        }
      : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    completionFields: row.completedAt
      ? completionOwnsMetadata
        ? { metadata: row.metadata }
        : {}
      : null,
    completionEventId: row.completionEventId,
    startEventId: row.startEventId,
    completionFieldOrigins: origins,
    // Step has no persisted `lastEventAt` (schema.prisma: liveness is a Run-only concept).
    // `receivedAt` seeds the in-memory fold for this request; it is never written back.
    lastEventAt: row.receivedAt.getTime(),
  };
}
