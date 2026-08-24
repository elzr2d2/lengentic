/**
 * The Playground's composition root.
 *
 * `MVP_PLAN_V3.md` §4 allows exactly one edge out of here — `Playground → Telemetry SDK` —
 * and `pnpm check:boundaries` enforces it through five rules, of which
 * `playground-sdk-public-entry-only` is the narrowest: the Playground may reach
 * `@lengentic/telemetry-sdk` and never a path inside it. That makes this file the one place
 * the Playground names the SDK, so the rest of `playground/**` composes against a seam this
 * package owns rather than against someone else's package layout.
 *
 * It stays thin on purpose. The SDK already decides how telemetry is queued, batched,
 * bounded and retried; repeating any of that here would give the Playground a second
 * opinion on a contract it does not own.
 */
import {
  createTelemetryClient,
  SeededClock,
  SeededIdGenerator,
  systemScheduler,
  type CancelTimer,
  type Clock,
  type DiagnosticSink,
  type IdGenerator,
  type Scheduler,
  type StartRunInput,
  type TelemetryClient,
  type TelemetryConfig,
  type TelemetryTransport,
  type TransportResult,
} from '@lengentic/telemetry-sdk';

/**
 * The API the Playground talks to when nothing overrides it. The port is `API_PORT` from
 * `.env`; reading the environment is the CLI's job, not this seam's.
 */
export const PLAYGROUND_DEFAULT_ENDPOINT = 'http://localhost:3001';

/**
 * A Playground run is short-lived and ends in `shutdown()`, so the SDK's one-second flush
 * interval would put the whole run in a single batch at exit. Flushing sooner and in
 * smaller batches means a run is observable in LenGentic while it is still running, which
 * is the behaviour the Playground exists to demonstrate.
 *
 * Both values are inside the SDK's own bounds and are overridable per call.
 */
export const PLAYGROUND_TELEMETRY_DEFAULTS = Object.freeze({
  flushIntervalMs: 250,
  maxBatchSize: 25,
});

export function createPlaygroundTelemetry(config: TelemetryConfig = {}): TelemetryClient {
  return createTelemetryClient({
    endpoint: PLAYGROUND_DEFAULT_ENDPOINT,
    ...PLAYGROUND_TELEMETRY_DEFAULTS,
    ...config,
  });
}

/**
 * Re-exported so `playground/**` has one import site for the SDK surface it uses. These are
 * the SDK's types unchanged — the Playground does not restate the wire contract, which
 * `platform/shared/schema/**` owns (CLAUDE.md `## Types`).
 */
export type { Clock, DiagnosticSink, IdGenerator, StartRunInput, TelemetryClient, TelemetryConfig };

/**
 * The rest of the SDK surface `playground/**` composes against — seeded determinism
 * (`determinism/seed.ts`), the timer seam `MockProvider` schedules its simulated delay
 * through (`providers/mock-provider.ts`), and the two test-only types the fake scheduler and
 * recording transport under each `test/support` directory need to implement the SDK's own
 * interfaces. Re-exported here rather than left to five separate direct imports, so this
 * file stays the one place the Playground names the SDK (see the module doc above).
 */
export { SeededClock, SeededIdGenerator, systemScheduler };
export type { CancelTimer, Scheduler, TelemetryTransport, TransportResult };
