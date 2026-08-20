import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@lengentic/database';
import { PrismaService } from '../prisma/prisma.service';
import type { CompletionFieldOrigin, EntityMergeState, MergeEntityStatus } from './merge-rules';
import type { EntityKind } from './event-mapping';

// Prisma types never cross this file's boundary outward (CLAUDE.md ## Types) — every public
// method here takes or returns `EntityMergeState` (merge-rules.ts's domain type), never a
// Run/Step row. `RunRow`/`StepRow` are inferred structurally from `PrismaClient` itself
// (`@lengentic/database`'s public surface re-exports only the client type, not its models —
// database/src/index.ts's own header comment), so this mapping cannot silently drift from
// the generated client.
type RunRow = NonNullable<Awaited<ReturnType<PrismaClient['run']['findUnique']>>>;
type StepRow = NonNullable<Awaited<ReturnType<PrismaClient['step']['findUnique']>>>;

// The subset of the client every load/save helper below actually touches — satisfied both
// by `PrismaService.client` (the top-level connection) and by the scoped client Prisma's
// interactive `$transaction` hands its callback, so the same helpers serve `loadRun`/
// `saveRun`/etc. AND `withEntityLock` without duplicating the row-mapping logic.
type EntityClient = Pick<PrismaClient, 'run' | 'step' | 'ingestedEvent'>;

// Prisma 7's interactive-transaction callback parameter, recovered structurally for the same
// reason as `RunRow`/`StepRow` above: `@lengentic/database` exports only `PrismaClient` as a
// type, not the `Prisma` namespace `Prisma.TransactionClient` would need.
type TransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

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
    return loadRunWith(this.prisma.client, id);
  }

  async loadStep(id: string): Promise<EntityMergeState | undefined> {
    return loadStepWith(this.prisma.client, id);
  }

  /**
   * Upserts the final, already-folded state for one Run. `id` is both the primary key and
   * (per schema.prisma's own note) today's `traceId` — set on create only, never touched by
   * `update`. `receivedAt` is likewise create-only: schema.prisma is explicit that it "is
   * set once, on row creation, and never updated"; only `update`'s payload is reused for
   * both branches, so it must never include `receivedAt`.
   */
  async saveRun(id: string, state: EntityMergeState): Promise<void> {
    return saveRunWith(this.prisma.client, id, state);
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
    return saveStepWith(this.prisma.client, id, runId, state);
  }

  /**
   * F1 fix (tester regression, 2026-08-19): loads, folds and saves one entity's state as a
   * single atomic unit — the read-modify-write `TelemetryService.ingest` needs per entity,
   * moved wholesale into one Postgres transaction guarded by a transaction-scoped advisory
   * lock keyed on `(kind, entityId)`.
   *
   * Why an advisory lock rather than `SELECT ... FOR UPDATE`: the race that needs closing
   * includes two concurrent FIRST events for an entity that has no row yet — nothing exists
   * for `FOR UPDATE` to lock in that case, so it would not serialize the two inserts. The
   * advisory lock is acquired unconditionally, before the row is read, whether or not it
   * exists yet.
   *
   * Why an advisory lock rather than an in-process mutex: this process may not be the only
   * API replica reading and writing this entity (`MVP_PLAN_V3.md` deploys the API
   * independently of the number of replicas) — a mutex only ever serializes writers inside
   * one process.
   *
   * F3 fix (ADR 0009): `alreadyIngested` — the third argument `fold` receives — is read from
   * the `IngestedEvent` ledger (ADR 0005 §1), not reconstructed from entity-state provenance.
   * It answers "have I seen this eventId?" completely: every event this entity has EVER
   * accepted is in there, winners and losers of a merge contest alike, unlike
   * `startEventId`/`completionEventId`/`completionFieldOrigins`, which record only whichever
   * event currently owns a field. The lookup is scoped to `eventIds` (the batch's own event
   * ids for this group) and to `runId` (ADR 0005 §2 — `eventId` is unique per run, not
   * globally, so a lookup that ignored `runId` could misclassify a genuinely new run's
   * replayed seeded scenario as DUPLICATE).
   *
   * `p2.run-liveness`: for a STEP group that accepts at least one event, this also advances
   * the referenced Run's `lastEventAt` (`touchRunLiveness` below), inside the same
   * transaction. That is a cross-entity effect the per-entity `mergeEvent` fold structurally
   * cannot express, and leaving it out is what made a live, step-emitting run derive as STALE.
   *
   * `fold` receives the entity's state and the ledger's answer as read AFTER the lock is
   * acquired (so it observes every write a prior holder committed, not a snapshot taken
   * before this request even started), and returns the state to persist (`undefined` to
   * persist nothing — e.g. every event in the group was a duplicate), the `eventIds` to
   * record in the ledger (the ones this fold actually accepted — never a duplicate's, which
   * is already there), and an arbitrary `value` the caller gets back. The whole
   * load-fold-save-record round trip happens inside the same transaction as the lock, so it
   * commits (releasing the lock) or the caller sees the transaction's rejection.
   */
  async withEntityLock<T>(
    kind: EntityKind,
    entityId: string,
    runId: string,
    eventIds: readonly string[],
    receivedAt: number,
    fold: (
      existing: EntityMergeState | undefined,
      alreadyIngested: ReadonlySet<string>,
    ) => {
      state: EntityMergeState | undefined;
      newlyIngestedEventIds: readonly string[];
      value: T;
    },
  ): Promise<T> {
    return this.prisma.client.$transaction(async (tx) => {
      await lockEntity(tx, kind, entityId);
      const existing =
        kind === 'run' ? await loadRunWith(tx, entityId) : await loadStepWith(tx, entityId);
      const alreadyIngested = await loadIngestedEventIds(tx, runId, eventIds);
      const { state, newlyIngestedEventIds, value } = fold(existing, alreadyIngested);
      if (state !== undefined) {
        if (kind === 'run') {
          await saveRunWith(tx, entityId, state);
        } else {
          await saveStepWith(tx, entityId, runId, state);
        }
      }
      if (newlyIngestedEventIds.length > 0) {
        // Run-scoped liveness (`p2.run-liveness`). A `step.*` event's ENTITY is the Step, so
        // the fold above only ever advances the Step's own state — and Step has no
        // `lastEventAt` column at all (schema.prisma:144: "liveness is a Run concept, and a
        // step's aliveness question is really 'is its run stale'"). Without this, a workflow
        // that is alive and emitting steps leaves `Run.lastEventAt` frozen at its last
        // run-level event, derives as STALE past `STALE_RUN_THRESHOLD_MS` (§13), and is then
        // "excluded from all historical aggregation" — a false positive that deletes real
        // data from every downstream number.
        //
        // Gated on `newlyIngestedEventIds` — the events this fold ACCEPTED — so a step event
        // the ADR 0005 §1 / ADR 0009 ledger already knows (a `DUPLICATE`) does not advance
        // run liveness. A replayed batch must not be able to keep a dead run looking alive.
        if (kind === 'step') {
          await touchRunLiveness(tx, runId, new Date(receivedAt));
        }
        await recordIngestedEvents(tx, runId, newlyIngestedEventIds, new Date(receivedAt));
      }
      return value;
    });
  }
}

// Advisory-lock namespace: keeps the Run id space and the Step id space from colliding
// inside one 32-bit hash (a Run and a Step could otherwise share a client-generated id and
// serialize against each other for no reason). Values are arbitrary; they only need to stay
// stable and distinct.
const LOCK_NAMESPACE: Record<EntityKind, number> = { run: 1, step: 2 };

/**
 * `pg_advisory_xact_lock(key1, key2)` — transaction-scoped, released automatically on commit
 * OR rollback, so a crash mid-request can never leak a held lock the way an explicit
 * `pg_advisory_unlock` could. `hashtext(entityId)` folds the client-generated id
 * (`VarChar(128)`) down to the `int4` the two-key overload requires. A 32-bit hash collision
 * between two different entityIds only costs extra serialization — the two unrelated
 * entities briefly queue behind one lock — it can never produce a wrong merge, so the
 * lossiness is safe to accept.
 */
async function lockEntity(
  tx: TransactionClient,
  kind: EntityKind,
  entityId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE[kind]}::int, hashtext(${entityId}))`;
}

/**
 * The ADR 0005 §1 ledger's read side (F3, ADR 0009): which of THIS batch's `eventIds`, for
 * THIS run, have already been recorded as ingested — complete, unlike the entity-state
 * provenance this replaces, because every accepted event is written here regardless of
 * whether it goes on to win or lose its merge contest. Scoped to `runId` per ADR 0005 §2
 * (`eventId` is unique per run, not globally). An empty `eventIds` short-circuits — an empty
 * `IN ()` is either a Prisma-level error or a wasted round trip depending on driver, and a
 * group with zero items never happens today, but the guard costs nothing.
 */
async function loadIngestedEventIds(
  client: EntityClient,
  runId: string,
  eventIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (eventIds.length === 0) return new Set();
  const rows = await client.ingestedEvent.findMany({
    where: { runId, eventId: { in: [...eventIds] } },
    select: { eventId: true },
  });
  return new Set(rows.map((row) => row.eventId));
}

/**
 * The ledger's write side. `skipDuplicates: true` is a safety net, not the mechanism that
 * prevents a double-record under concurrency — the advisory lock already serializes every
 * writer for this `entityId`, and every `eventId` here belongs to exactly this call's
 * `entityId` (one event updates exactly one entity), so two concurrent requests recording the
 * same `eventId` is already excluded by the lock. What `skipDuplicates` actually guards is a
 * caller passing an `eventId` `loadIngestedEventIds` did not have a chance to see yet — never
 * expected on the path `TelemetryService.ingest` takes today, but a silent no-op is the safe
 * failure mode if it ever happens, not a thrown, batch-aborting unique-constraint violation.
 */
async function recordIngestedEvents(
  client: EntityClient,
  runId: string,
  eventIds: readonly string[],
  receivedAt: Date,
): Promise<void> {
  await client.ingestedEvent.createMany({
    data: eventIds.map((eventId) => ({ eventId, runId, receivedAt })),
    skipDuplicates: true,
  });
}

/**
 * Advances one Run's `lastEventAt` to the server clock of an event that REFERENCES it but
 * whose entity is a Step. Run liveness means "the server clock of the last event referencing
 * this run", `step.*` events included — the competing reading (run-level events only) makes
 * §13's own Definition-of-Done check "killing the script mid-run leaves a Run that derives as
 * STALE" untestable, because under it any run longer than the threshold goes STALE with
 * nothing killed.
 *
 * Three properties, all carried by the shape of this ONE statement rather than by a
 * read-modify-write this function would have to serialize itself:
 *
 * - MONOTONIC. `lastEventAt: { lt: receivedAt }` is the guard `merge-rules.ts` expresses as
 *   `Math.max` — the value can only ever move forward, so an out-of-order or late-arriving
 *   step event whose request clock is older than what the row already holds is a no-op, not a
 *   regression. Under concurrency Postgres re-evaluates that `WHERE` against the row version
 *   the winning transaction committed (READ COMMITTED / EvalPlanQual), so two racing step
 *   groups for the same run cannot leave the earlier of the two clocks behind.
 * - NEVER CREATES A RUN. `updateMany` matches zero rows and does nothing when the run has not
 *   been seen yet. An orphan step must not conjure a Run shell — schema.prisma is explicit
 *   that Step has NO foreign key to Run precisely because "a stub `Run` cannot be conjured:
 *   the workflow fields live only on the start payload". Nothing here changes that: the
 *   step's own row still lands, and the run's row appears only when a real `run.*` event
 *   creates it.
 * - ATOMIC WITH THE LEDGER. It runs inside the caller's transaction, alongside the
 *   `IngestedEvent` write, so a group whose transaction rolls back has neither recorded its
 *   events as ingested nor advanced run liveness. Doing this in a second transaction after
 *   the group committed would leave the opposite failure available: a retry sees `DUPLICATE`,
 *   skips the fold, and the liveness bump the first attempt lost is never made again.
 *
 * Deliberately NOT part of the `mergeEvent` fold: that reducer is per-entity and pure
 * (merge-rules.ts's own header), and a Step's state has nowhere to put a Run's column. The
 * cross-entity effect belongs to the unit that owns persisting one group's events, which is
 * `withEntityLock`.
 */
async function touchRunLiveness(
  client: EntityClient,
  runId: string,
  receivedAt: Date,
): Promise<void> {
  await client.run.updateMany({
    where: { id: runId, lastEventAt: { lt: receivedAt } },
    data: { lastEventAt: receivedAt },
  });
}

async function loadRunWith(
  client: EntityClient,
  id: string,
): Promise<EntityMergeState | undefined> {
  const row = await client.run.findUnique({ where: { id } });
  return row ? runRowToState(row) : undefined;
}

async function loadStepWith(
  client: EntityClient,
  id: string,
): Promise<EntityMergeState | undefined> {
  const row = await client.step.findUnique({ where: { id } });
  return row ? stepRowToState(row) : undefined;
}

async function saveRunWith(
  client: EntityClient,
  id: string,
  state: EntityMergeState,
): Promise<void> {
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

  await client.run.upsert({
    where: { id },
    create: { id, traceId: id, receivedAt: new Date(state.lastEventAt), ...columns },
    update: columns,
  });
}

async function saveStepWith(
  client: EntityClient,
  id: string,
  runId: string,
  state: EntityMergeState,
): Promise<void> {
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

  await client.step.upsert({
    where: { id },
    create: { id, runId, receivedAt: new Date(state.lastEventAt), ...columns },
    update: columns,
  });
}

function toDate(iso: string | null): Date | null {
  return iso === null ? null : new Date(iso);
}

// The exact input type Prisma generates for a nullable Json column, recovered structurally
// from `PrismaClient` itself (same technique as `RunRow`/`StepRow`/`TransactionClient`
// above) rather than imported from `@prisma/client`/`**/generated/prisma/**`, which
// `no-restricted-imports` forbids here (CLAUDE.md ## Types). `Run.metadata` and
// `Step.metadata`/`completionFieldOrigins` are all nullable Json columns generated from the
// same Prisma `Json?` scalar, so they share this one type. `undefined` is excluded because
// Prisma 7's generated `InputJsonValue` has no `undefined` member — `null` is the only legal
// "no value" input.
type JsonColumnInput = Exclude<
  NonNullable<Parameters<PrismaClient['run']['upsert']>[0]['create']>['metadata'],
  undefined
>;

/**
 * `value` originates from `EntityMergeState`'s deliberately-opaque `fields` bag
 * (merge-rules.ts's own header: callers narrow it, not merge-rules itself), so this is the
 * one place that bag is asserted into the shape Prisma's generated types require.
 */
function toJsonInput(value: unknown): JsonColumnInput {
  return (value === undefined ? null : value) as JsonColumnInput;
}

function toRunStatus(status: MergeEntityStatus): RunRow['status'] {
  return status;
}

function runRowToState(row: RunRow): EntityMergeState {
  const origins = toOrigins(row.completionFieldOrigins);
  const completionOwnsMetadata = hasCompletionMetadata(origins);

  return {
    entityId: row.id,
    status: row.status,
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
    status: row.status,
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
