import type {
  DecisionOutcome,
  TelemetryEventEnvelope,
  TelemetryEventOf,
  TelemetryEventType,
} from '@lengentic/shared';

import { BoundedQueue } from './bounded-queue';
import { resolveConfig, type ResolvedTelemetryConfig, type TelemetryConfig } from './config';
import {
  describeError,
  type TelemetryDiagnostic,
  type TelemetryDiagnosticCode,
} from './diagnostics';
import { buildEnvelope, checkEnvelope } from './events';
import {
  createRun,
  recordAttestation,
  type CrossProcessAttestOutcomeInput,
  type EventRecorder,
  type RunHandle,
  type StartRunInput,
} from './handles';
import { createPayloadSafety, type PayloadSafety } from './payload-safety';
import type { CancelTimer } from './scheduler';
import type { TransportResult } from './transport';

/** Everything the SDK did instead of throwing. §16 requires at least the dropped counter. */
export interface TelemetryStats {
  /** Events waiting in the bounded buffer right now. */
  readonly queued: number;
  /** Events that passed the wire contract and entered the buffer. */
  readonly recorded: number;
  /** Events the transport confirmed it delivered. */
  readonly delivered: number;
  /** Oldest events discarded because the buffer was full. */
  readonly droppedOverflow: number;
  /** Events that failed the wire contract or could not be serialized. */
  readonly droppedInvalid: number;
  /** Events over §12's per-event byte cap. */
  readonly droppedTooLarge: number;
  /** Events recorded after shutdown(). */
  readonly droppedAfterShutdown: number;
  /** Events in batches given up on after the bounded retry budget ran out. */
  readonly droppedUndeliverable: number;
  /** Individual failed delivery attempts, retries included. */
  readonly deliveryFailures: number;
  /**
   * The server's own claim about a `delivered` batch — from `IngestResponse.accepted`
   * (`platform/shared/schema/ingest.ts`), summed across every batch whose response could be
   * read. Distinct from `delivered`: `delivered` is a transport count ("the batch reached
   * the API"), `serverAccepted` is a persistence count ("the API says it created something
   * new"). A run whose ingest was entirely deduplicated has `delivered > 0` and
   * `serverAccepted === 0` (F1: `.artifacts/evidence/3/phase-gate/tester/README.md`).
   */
  readonly serverAccepted: number;
  /** From `IngestResponse.duplicate` — events the server recognised as an ledger key
   *  (`runId`, `eventId`) it had already accepted, summed the same way as `serverAccepted`. */
  readonly serverDuplicate: number;
  /** From `IngestResponse.rejected` — events the server refused, summed the same way. */
  readonly serverRejected: number;
  /**
   * Events in a `delivered` batch whose response body could not be read as an
   * `IngestResponse` (`transport.ts`'s `response: null`) — a 2xx whose JSON body was absent,
   * malformed, or off the wire contract. Kept separate from `serverAccepted: 0` on purpose:
   * "the server said zero were new" and "the server's answer could not be understood" are
   * different facts, and collapsing them would make an unparseable response indistinguishable
   * from an all-duplicate batch.
   */
  readonly serverCountsUnavailable: number;
}

export interface TelemetryClient {
  startRun(input: StartRunInput): RunHandle;
  /**
   * §14's cross-process attestation: "any process, hours later". Needs no live Run or Step
   * handle — the ids the caller persisted are the whole correlation. Idempotent by
   * construction on the server (last write wins on `decisionId`), and accepted even when
   * the decision itself has not arrived yet.
   */
  attestOutcome(
    decisionId: string,
    outcome: DecisionOutcome,
    input: CrossProcessAttestOutcomeInput,
  ): void;
  /** Drains what is queued now. Never rejects. */
  flush(): Promise<void>;
  /** §16 "Flushable": drains the queue, then stops. Idempotent, bounded, never rejects. */
  shutdown(): Promise<void>;
  stats(): TelemetryStats;
}

class Client implements TelemetryClient, EventRecorder {
  private readonly config: ResolvedTelemetryConfig;

  /**
   * §15's one shared client-side safe serializer, built once per client. `handles.ts` is
   * its only caller — every arbitrary JSON field on every event type passes through this
   * instance, so a redaction default can never be in force for one field and absent for
   * another.
   */
  readonly safety: PayloadSafety;

  private readonly queue: BoundedQueue<TelemetryEventEnvelope>;

  private readonly wakeups = new Set<() => void>();

  private flushTimer: CancelTimer | null = null;

  private pumping: Promise<void> | null = null;

  private shutdownRun: Promise<void> | null = null;

  /** Stops accepting new events. Set by shutdown() before the drain starts. */
  private closed = false;

  /** Stops draining. Set only when shutdown() hit its bound with work still pending. */
  private abandoned = false;

  /**
   * True between the start and the end of shutdown(). Timers scheduled while it is true
   * hold the process open, so an awaited drain in a short-lived script actually completes
   * (§16) rather than being cut short by a runtime that sees nothing left to wait for.
   */
  private draining = false;

  private inFlight: AbortController | null = null;

  /**
   * ADR 0014 decision 2's batch-level `droppedSinceLastBatch` is "since the LAST batch",
   * and the only honest reading of that is "not yet acknowledged by a batch the far end
   * actually took". This is that acknowledged baseline: it advances ONLY after a
   * `delivered` outcome, by exactly the snapshot that batch carried. A failed attempt
   * therefore never clears a drop, a retry re-reports the same snapshot rather than a
   * freshly grown one, and two consecutive successful batches cannot count the same drop
   * twice.
   */
  private acknowledgedDrops = 0;

  private readonly counters = {
    recorded: 0,
    delivered: 0,
    droppedInvalid: 0,
    droppedTooLarge: 0,
    droppedAfterShutdown: 0,
    droppedUndeliverable: 0,
    deliveryFailures: 0,
    serverAccepted: 0,
    serverDuplicate: 0,
    serverRejected: 0,
    serverCountsUnavailable: 0,
  };

  constructor(config: TelemetryConfig) {
    // The one throw in the SDK, and it happens before any event can exist (§16).
    this.config = resolveConfig(config);
    this.safety = createPayloadSafety({
      redact: this.config.redact,
      maxFieldBytes: this.config.maxFieldBytes,
      captureToolIO: this.config.captureToolIO,
    });
    this.queue = new BoundedQueue<TelemetryEventEnvelope>(this.config.maxQueueSize);
  }

  startRun(input: StartRunInput): RunHandle {
    return createRun(this, input);
  }

  attestOutcome(
    decisionId: string,
    outcome: DecisionOutcome,
    input: CrossProcessAttestOutcomeInput,
  ): void {
    recordAttestation(this, decisionId, input.runId, outcome, input);
  }

  nextId(): string {
    return this.config.idGenerator.next();
  }

  noteIgnoredCompletion(entityId: string): void {
    this.emit('completion_ignored', `complete() called more than once for ${entityId}`, 0, 0);
  }

  record<K extends TelemetryEventType>(
    type: K,
    entityId: string,
    runId: string,
    payload: TelemetryEventOf<K>['payload'],
  ): void {
    try {
      this.enqueue(type, entityId, runId, payload);
    } catch (error) {
      // §16: "The record methods must not throw because of circular data, redaction
      // failure, serialization failure, transport failure, or buffer overflow." Each of
      // those has its own handled path below; this catch is the backstop that makes the
      // guarantee unconditional, including for an injected clock or sink that misbehaves.
      this.counters.droppedInvalid += 1;
      this.emit('event_invalid', `record failed: ${describeError(error)}`, 1, 0);
    }
  }

  async flush(): Promise<void> {
    await this.requestPump();
    // A second pass picks up anything recorded while the first was in flight. Bounded at
    // two on purpose: a caller emitting faster than the transport drains must not be able
    // to make flush() run forever.
    if (this.queue.size > 0 && !this.abandoned) await this.requestPump();
  }

  shutdown(): Promise<void> {
    this.shutdownRun ??= this.performShutdown();
    return this.shutdownRun;
  }

  stats(): TelemetryStats {
    return {
      queued: this.queue.size,
      recorded: this.counters.recorded,
      delivered: this.counters.delivered,
      droppedOverflow: this.queue.dropped,
      droppedInvalid: this.counters.droppedInvalid,
      droppedTooLarge: this.counters.droppedTooLarge,
      droppedAfterShutdown: this.counters.droppedAfterShutdown,
      droppedUndeliverable: this.counters.droppedUndeliverable,
      deliveryFailures: this.counters.deliveryFailures,
      serverAccepted: this.counters.serverAccepted,
      serverDuplicate: this.counters.serverDuplicate,
      serverRejected: this.counters.serverRejected,
      serverCountsUnavailable: this.counters.serverCountsUnavailable,
    };
  }

  /**
   * §16's five drop counters, summed. `droppedOverflow` lives on the queue rather than in
   * `counters`, which is why this reads both. The SUM and not the breakdown is deliberate:
   * `IngestRequestSchema.droppedSinceLastBatch` carries one number, and anything that needs
   * the per-reason split reads `stats()`.
   */
  private totalDropped(): number {
    return (
      this.queue.dropped +
      this.counters.droppedInvalid +
      this.counters.droppedTooLarge +
      this.counters.droppedAfterShutdown +
      this.counters.droppedUndeliverable
    );
  }

  /**
   * What the next batch should report: everything dropped, less everything a delivered
   * batch has already carried. Never negative — `acknowledgedDrops` only ever advances by a
   * snapshot taken from this same subtraction.
   *
   * NOT clamped to `IngestRequestSchema`'s `MAX_DROPPED_SINCE_LAST_BATCH` (2^31-1), which
   * that schema REJECTS rather than clamps. Reaching it needs 2.1 billion drops in one
   * process lifetime, and the constant is not on `@lengentic/shared`'s public entry, so
   * exporting it is a change to a package this packet may not write. Recorded in
   * `BACKLOG.md` (2026-09-03) rather than mirrored into a third copy of the number.
   */
  private pendingDropReport(): number {
    return this.totalDropped() - this.acknowledgedDrops;
  }

  private enqueue<K extends TelemetryEventType>(
    type: K,
    entityId: string,
    runId: string,
    payload: TelemetryEventOf<K>['payload'],
  ): void {
    if (this.closed) {
      this.counters.droppedAfterShutdown += 1;
      this.emit('client_closed', `${type} recorded after shutdown(); dropped`, 1, 0);
      return;
    }

    const envelope = buildEnvelope({
      eventId: this.config.idGenerator.next(),
      type,
      entityId,
      runId,
      occurredAt: this.config.clock.now(),
      payload,
    });

    const check = checkEnvelope(envelope);
    if (!check.ok) {
      if (check.code === 'event_too_large') this.counters.droppedTooLarge += 1;
      else this.counters.droppedInvalid += 1;
      this.emit(check.code, check.reason, 1, 0);
      return;
    }

    const dropped = this.queue.push(envelope);
    this.counters.recorded += 1;
    if (dropped > 0) {
      this.emit(
        'queue_overflow',
        `buffer full at ${this.config.maxQueueSize}; dropped ${dropped} oldest event(s)`,
        dropped,
        0,
      );
    }
    this.scheduleWork();
  }

  /** §16: flush on interval or on buffer size, whichever comes first. */
  private scheduleWork(): void {
    if (this.queue.size >= this.config.maxBatchSize) {
      this.cancelFlushTimer();
      void this.requestPump();
      return;
    }
    this.armFlushTimer();
  }

  private armFlushTimer(): void {
    if (this.flushTimer !== null || this.closed) return;
    this.flushTimer = this.schedule(() => {
      this.flushTimer = null;
      void this.requestPump();
    }, this.config.flushIntervalMs);
  }

  private cancelFlushTimer(): void {
    if (this.flushTimer === null) return;
    this.flushTimer();
    this.flushTimer = null;
  }

  /** Single-flight: the transport is never called concurrently. */
  private requestPump(): Promise<void> {
    this.pumping ??= this.pump().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
  }

  private async pump(): Promise<void> {
    while (this.queue.size > 0 && !this.abandoned) {
      await this.deliverBatch(this.queue.take(this.config.maxBatchSize));
    }
  }

  private async deliverBatch(batch: TelemetryEventEnvelope[]): Promise<void> {
    const maxAttempts = this.config.maxRetries + 1;
    let attempt = 0;

    // Snapshotted ONCE, here, before the first attempt — not inside the loop. Drops that
    // happen while this batch is in flight (an overflow from a caller still recording) grow
    // the pending count, and re-reading it per attempt would send a retry a number the
    // earlier attempt might already have delivered.
    const droppedSinceLastBatch = this.pendingDropReport();

    // `!this.abandoned` at the TOP, not only after the attempt: once shutdown() has given
    // up, waking the pending backoff must end the batch, never start one more request. The
    // trailing check below cannot cover this — it runs after an attempt has already gone out.
    while (attempt < maxAttempts && !this.abandoned) {
      attempt += 1;
      const result = await this.attemptDelivery(batch, droppedSinceLastBatch);
      if (result.outcome === 'delivered') {
        // The baseline advances here and nowhere else: the far end has the number now.
        this.acknowledgedDrops += droppedSinceLastBatch;
        this.counters.delivered += batch.length;
        if (result.response !== null) {
          this.counters.serverAccepted += result.response.accepted;
          this.counters.serverDuplicate += result.response.duplicate;
          this.counters.serverRejected += result.response.rejected;
        } else {
          // A 2xx whose body could not be read as an `IngestResponse` (`transport.ts`'s
          // `readIngestResponse`) still delivered the batch — `delivered` above is correct
          // either way — but says nothing about which events were new. Counting the whole
          // batch as unattributed keeps `serverAccepted: 0` from being misread as "the
          // server said none of these were new" (O2:
          // `.artifacts/evidence/3/phase-gate/tester/README.md`).
          this.counters.serverCountsUnavailable += batch.length;
        }
        return;
      }
      this.counters.deliveryFailures += 1;
      this.emit(
        'delivery_failed',
        `attempt ${attempt} of ${maxAttempts} failed: ${result.detail}`,
        batch.length,
        attempt,
      );
      // `attempt === maxAttempts` looks redundant against the loop condition and is not:
      // without it the last failed attempt would still sit out a backoff nobody will use.
      if (result.outcome === 'permanent' || attempt === maxAttempts || this.abandoned) break;
      await this.delay(this.backoffFor(attempt));
    }

    // §16 requires the retry budget to be FINITE. This is where finite stops being a
    // configuration value and becomes an observable event: the batch is lost, and counted.
    this.counters.droppedUndeliverable += batch.length;
    this.emit(
      'batch_dropped',
      `gave up on ${batch.length} event(s) after ${attempt} attempt(s)`,
      batch.length,
      attempt,
    );
  }

  private async attemptDelivery(
    batch: TelemetryEventEnvelope[],
    droppedSinceLastBatch: number,
  ): Promise<TransportResult> {
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      return await this.raceTimeout(
        this.invokeTransport(batch, controller.signal, droppedSinceLastBatch),
        controller,
      );
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  /**
   * ASYNC-4. The signal is a request; this race is the guarantee. A transport that ignores
   * cancellation and never settles still cannot hold the caller — the timer resolves the
   * attempt without it, and the abandoned promise cannot reject because `invokeTransport`
   * never rejects.
   */
  private raceTimeout(
    work: Promise<TransportResult>,
    controller: AbortController,
  ): Promise<TransportResult> {
    return new Promise<TransportResult>((settle) => {
      let cancel: CancelTimer = () => undefined;
      let done = false;

      const finish = (result: TransportResult): void => {
        if (done) return;
        done = true;
        cancel();
        this.wakeups.delete(abandon);
        settle(result);
      };

      // shutdown() giving up must not leave a live timer, or an attempt promise nothing
      // will ever settle, behind it.
      const abandon = (): void => {
        controller.abort();
        finish({ outcome: 'retryable', detail: 'attempt abandoned at shutdown' });
      };

      cancel = this.schedule(() => {
        controller.abort();
        finish({
          outcome: 'retryable',
          detail: `attempt timed out after ${this.config.requestTimeoutMs}ms`,
        });
      }, this.config.requestTimeoutMs);
      this.wakeups.add(abandon);

      void work.then(finish);
    });
  }

  private async invokeTransport(
    batch: TelemetryEventEnvelope[],
    signal: AbortSignal,
    droppedSinceLastBatch: number,
  ): Promise<TransportResult> {
    try {
      return await this.config.transport.send(batch, { signal, droppedSinceLastBatch });
    } catch (error) {
      // Covers a custom transport that throws synchronously as well as one that rejects.
      return { outcome: 'retryable', detail: `transport threw: ${describeError(error)}` };
    }
  }

  private backoffFor(attempt: number): number {
    return Math.min(this.config.maxBackoffMs, this.config.initialBackoffMs * 2 ** (attempt - 1));
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((done) => {
      let cancel: CancelTimer = () => undefined;
      const wake = (): void => {
        cancel();
        this.wakeups.delete(wake);
        done();
      };
      cancel = this.schedule(wake, ms);
      this.wakeups.add(wake);
    });
  }

  /** Resolves every outstanding backoff immediately so shutdown does not wait one out. */
  private abandonWaits(): void {
    for (const wake of [...this.wakeups]) wake();
  }

  private async performShutdown(): Promise<void> {
    this.closed = true;
    this.draining = true;
    this.cancelFlushTimer();

    const deadline = this.deadline(this.config.shutdownTimeoutMs);
    const drained = await Promise.race([
      this.flush().then(
        () => true,
        (error: unknown) => {
          this.emit('batch_dropped', `flush failed: ${describeError(error)}`, this.queue.size, 0);
          return true;
        },
      ),
      deadline.promise.then(() => false),
    ]);
    deadline.cancel();

    if (!drained) {
      this.abandoned = true;
      this.inFlight?.abort();
      this.abandonWaits();
      this.emit(
        'shutdown_timeout',
        `shutdown gave up after ${this.config.shutdownTimeoutMs}ms with ${this.queue.size} event(s) still queued`,
        this.queue.size,
        0,
      );
    }

    // Whatever the outcome, the SDK stops holding the process from here on.
    this.draining = false;
  }

  private deadline(ms: number): { promise: Promise<void>; cancel: CancelTimer } {
    let cancel: CancelTimer = () => undefined;
    const promise = new Promise<void>((done) => {
      cancel = this.schedule(done, ms);
    });
    return { promise, cancel: () => cancel() };
  }

  private schedule(callback: () => void, delayMs: number): CancelTimer {
    return this.config.scheduler.schedule(callback, delayMs, {
      keepProcessAlive: this.draining,
    });
  }

  private emit(
    code: TelemetryDiagnosticCode,
    message: string,
    eventCount: number,
    attempt: number,
  ): void {
    const diagnostic: TelemetryDiagnostic = { code, message, eventCount, attempt };
    try {
      this.config.onDiagnostic(diagnostic);
    } catch {
      // Deliberately terminal, and the one place ERR-1 is answered by design rather than by
      // a log: the sink IS the reporting channel. Re-entering a sink that just threw would
      // either recurse or throw into host code, and §16 forbids the second absolutely. The
      // failure is still visible to the host — it happened in the host's own callback.
    }
  }
}

export function createTelemetryClient(config: TelemetryConfig): TelemetryClient {
  return new Client(config);
}
