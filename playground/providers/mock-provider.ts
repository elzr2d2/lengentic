/**
 * MockProvider — Phase 3's stand-in for a real LLM/tool provider (`MVP_PLAN_V3.md` "Mock
 * Provider", work package 2). `MockAgent` (a later, separate work package) calls it once
 * per workflow step instead of calling a real provider, so a Playground run needs no API
 * key and no network access.
 *
 * Four properties the plan requires, each with its own seam below:
 *  - Deterministic output GIVEN A SEED  → `seed`, folded per-call through `deriveSeed`.
 *  - Configurable delay                 → `delayMs`, played through an injectable `Scheduler`.
 *  - Configurable failure                → `failureRate` and `alwaysFailSteps`.
 *  - Configurable CONTEXT VARIATION      → `contextSeed`, independent of `seed` (Phase 6
 *    needs runs that vary in context but not in outcome).
 *
 * `Scheduler` is `@lengentic/telemetry-sdk`'s existing timer seam (its public entry, not a
 * deep import — `playground-sdk-public-entry-only`). Reusing it here means a test drives
 * simulated latency the same way `platform/telemetry-sdk/test/support/fake-scheduler.ts`
 * drives the SDK's — a fake clock, not a real wait (`docs/ENGINEERING_STANDARDS.md` TEST-1).
 */
import { systemScheduler, type Scheduler } from '../index';

import { hashToSeed, mulberry32 } from './prng';

/**
 * One call's identity. `callIndex` (default 0) lets a caller that invokes the same `step`
 * more than once — a retry, a re-plan — address each call independently instead of every
 * repeat colliding on the first call's derived randomness.
 */
export interface MockProviderRequest {
  readonly step: string;
  readonly callIndex?: number;
}

/**
 * Deliberately not named `context` alone — `awarenessContext`/`rawContext` (CONTEXT.md,
 * §15/§29) are a *different*, bounded-and-redacted concept that belongs to an
 * `execution_strategy` Decision. This is the plan's own "CONTEXT VARIATION" phrase, kept
 * distinct so the two are never read as the same field.
 */
export type MockProviderContextVariation = Readonly<Record<string, string | number | boolean>>;

/** This provider's identity on the wire (`model_call.recorded`'s `provider` and `model`).
 *  Fixed values, because a mock has exactly one identity — `DESIGN-1`: an abstraction needs
 *  a second real variation, and there is no second provider here to vary against. They are
 *  reported on the call result rather than read from here by consumers, so a caller records
 *  what the invocation actually used instead of restating a constant of its own. */
export const MOCK_PROVIDER_NAME = 'mock';
export const MOCK_PROVIDER_MODEL = 'mock-model-v1';

/**
 * The measurements a call produces regardless of whether it resolved or rejected — the
 * facts `model_call.recorded` (§13) needs, carried on both outcomes so a failed call is
 * still reportable as a model call that happened. A failed call has no output, so
 * `outputTokens` belongs only to the success shape.
 */
export interface MockProviderCallStats {
  readonly provider: string;
  readonly model: string;
  /** The simulated latency this call actually waited — `resolveDelay`'s result, played
   *  through the injected `Scheduler`. A pure function of the seed and the request, so it
   *  is reproducible under replay; never a wall clock. */
  readonly latencyMs: number;
  readonly inputTokens: number;
}

export interface MockProviderResponse extends MockProviderCallStats {
  readonly step: string;
  readonly callIndex: number;
  /** Deterministic filler standing in for a real provider's generated content. */
  readonly detail: string;
  readonly contextVariation: MockProviderContextVariation;
  readonly outputTokens: number;
}

/**
 * Raised when the configured failure behaviour selects failure for a call — mirrors a real
 * provider call rejecting, so `MockAgent` exercises the same failure shape it would see
 * from a network provider, without a network.
 *
 * Carries the same `MockProviderCallStats` the success path does: a call that failed after
 * 40ms against a named model is exactly the thing "which models were called, where failures
 * occurred" (`MVP_PLAN_V3.md:1802`) asks a Run to show, and a rejection that dropped its own
 * measurements would leave the caller inventing them.
 */
export class MockProviderFailure extends Error {
  readonly step: string;

  readonly callIndex: number;

  readonly stats: MockProviderCallStats;

  constructor(step: string, callIndex: number, stats: MockProviderCallStats) {
    super(`MockProvider: simulated failure at step "${step}" (call ${callIndex})`);
    this.name = 'MockProviderFailure';
    this.step = step;
    this.callIndex = callIndex;
    this.stats = stats;
  }
}

/**
 * An invalid config is a programming error at construction time, not a runtime provider
 * failure — same split `TelemetryConfigError` draws in `platform/telemetry-sdk/src/config.ts`.
 */
export class MockProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MockProviderConfigError';
  }
}

export interface MockProviderConfig {
  /** Determines `detail` and, absent `contextSeed`, `contextVariation` too. */
  readonly seed: number;
  /**
   * Independent seed for `contextVariation` only. Defaults to `seed` (fully pinned output).
   * Set it to a value that changes between runs while `seed` stays fixed to get Phase 6's
   * "same outcome, different context" replay.
   */
  readonly contextSeed?: number;
  /** Simulated latency in ms before a call resolves or rejects. A fixed value, or a
   *  `[min, max]` range sampled deterministically per call. Default 0. */
  readonly delayMs?: number | { readonly min: number; readonly max: number };
  /** Probability in `[0, 1]` that a call fails, sampled deterministically per call from the
   *  `seed`. Default 0 — never fails unless configured to. */
  readonly failureRate?: number;
  /** Steps that always fail, regardless of `failureRate` — explicit scenario control. */
  readonly alwaysFailSteps?: readonly string[];
  /** Timer seam. Defaults to the SDK's real `systemScheduler`; tests inject a fake one. */
  readonly scheduler?: Scheduler;
}

/**
 * `deriveSeed` folds `seed`/`contextSeed` through `^` and `mulberry32` folds it through
 * `| 0` (`ToInt32`) — both lossless, and therefore collision-free between distinct inputs,
 * only inside the 32-bit signed integer range. Outside it, `ToInt32` wraps: `NaN`, `1.5`,
 * `2**32 + 1` and `1e21` all collapse to the same 32-bit value as some in-range seed, so
 * "different seed → different output" silently stops holding for a caller who never sees an
 * error. `failureRate` and `delayMs` are already validated; `seed`/`contextSeed` were the
 * one config field that was not.
 */
const MIN_SEED = -(2 ** 31);
const MAX_SEED = 2 ** 31 - 1;

function isValidSeed(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_SEED && value <= MAX_SEED;
}

/** Split out of `validateConfig` to keep its own cyclomatic complexity under the repo's
 *  ESLint ceiling — this is one self-contained check, not a shared branch. */
function validateSeeds(config: MockProviderConfig): void {
  if (!isValidSeed(config.seed)) {
    throw new MockProviderConfigError(
      `MockProvider: seed must be a 32-bit signed integer (${MIN_SEED}..${MAX_SEED}), got ${config.seed}`,
    );
  }
  if (config.contextSeed !== undefined && !isValidSeed(config.contextSeed)) {
    throw new MockProviderConfigError(
      `MockProvider: contextSeed must be a 32-bit signed integer (${MIN_SEED}..${MAX_SEED}), got ${config.contextSeed}`,
    );
  }
}

function validateConfig(config: MockProviderConfig): void {
  validateSeeds(config);

  const failureRate = config.failureRate ?? 0;
  if (!Number.isFinite(failureRate) || failureRate < 0 || failureRate > 1) {
    throw new MockProviderConfigError(
      `MockProvider: failureRate must be a finite number in [0, 1], got ${failureRate}`,
    );
  }

  const delayMs = config.delayMs;
  if (typeof delayMs === 'number') {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new MockProviderConfigError(
        `MockProvider: delayMs must be a finite number >= 0, got ${delayMs}`,
      );
    }
  } else if (delayMs !== undefined) {
    const { min, max } = delayMs;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
      throw new MockProviderConfigError(
        `MockProvider: delayMs range must satisfy 0 <= min <= max, got ${JSON.stringify(delayMs)}`,
      );
    }
  }
}

function resolveDelay(
  delayMs: number | { readonly min: number; readonly max: number },
  random: () => number,
): number {
  if (typeof delayMs === 'number') return delayMs;
  return Math.round(delayMs.min + random() * (delayMs.max - delayMs.min));
}

/**
 * The crude 4-characters-per-token rule of thumb real tokenizers land near. Deliberately not
 * a real tokenizer: `playground/providers` has no dependency budget for one, and this is a
 * mock. What matters for `model_call.recorded` is that the count is a real function of the
 * text this call actually handled — so it moves when the request or the generated content
 * moves, which a constant would not.
 */
const CHARS_PER_TOKEN = 4;

function countTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The request as the provider "saw" it — the same `step`/`callIndex` pair `deriveSeed`
 *  folds (with its own internal salt appended), so the input measurement describes the
 *  input the call was actually made with. */
function requestText(step: string, callIndex: number): string {
  return `${step}|${callIndex}`;
}

function buildDetail(step: string, callIndex: number, random: () => number): string {
  return `MockProvider response for step "${step}" (call ${callIndex}): ${random().toFixed(6)}`;
}

function buildContextVariation(
  step: string,
  callIndex: number,
  random: () => number,
): MockProviderContextVariation {
  return {
    variant: Math.floor(random() * 1_000_000),
    note: `context-variation:${step}:${callIndex}:${random().toFixed(6)}`,
  };
}

export class MockProvider {
  private readonly seed: number;

  private readonly contextSeed: number;

  private readonly delayMs: number | { readonly min: number; readonly max: number };

  private readonly failureRate: number;

  private readonly alwaysFailSteps: ReadonlySet<string>;

  private readonly scheduler: Scheduler;

  constructor(config: MockProviderConfig) {
    validateConfig(config);
    this.seed = config.seed;
    this.contextSeed = config.contextSeed ?? config.seed;
    this.delayMs = config.delayMs ?? 0;
    this.failureRate = config.failureRate ?? 0;
    this.alwaysFailSteps = new Set(config.alwaysFailSteps ?? []);
    this.scheduler = config.scheduler ?? systemScheduler;
  }

  /**
   * Resolves with a deterministic `MockProviderResponse`, or rejects with a
   * `MockProviderFailure`, after the configured simulated delay. Two `MockProvider`
   * instances built from the same `seed` (and `contextSeed`) resolve identically for the
   * same `request`, in any order and regardless of what other requests either instance has
   * already served — determinism is keyed on the request's own identity, not on a call
   * counter internal to this instance.
   */
  invoke(request: MockProviderRequest): Promise<MockProviderResponse> {
    if (request.step.length === 0) {
      return Promise.reject(
        new MockProviderConfigError('MockProvider.invoke: step must be a non-empty string'),
      );
    }

    const { step } = request;
    const callIndex = request.callIndex ?? 0;

    const outcomeRandom = mulberry32(this.deriveSeed(this.seed, step, callIndex, 'outcome'));
    const delayRandom = mulberry32(this.deriveSeed(this.seed, step, callIndex, 'delay'));
    const contextRandom = mulberry32(this.deriveSeed(this.contextSeed, step, callIndex, 'context'));

    const failureRoll = outcomeRandom();
    const failed = this.alwaysFailSteps.has(step) || failureRoll < this.failureRate;
    const delay = resolveDelay(this.delayMs, delayRandom);

    const detail = buildDetail(step, callIndex, outcomeRandom);
    const stats: MockProviderCallStats = {
      provider: MOCK_PROVIDER_NAME,
      model: MOCK_PROVIDER_MODEL,
      latencyMs: delay,
      inputTokens: countTokens(requestText(step, callIndex)),
    };

    const response: MockProviderResponse = {
      ...stats,
      step,
      callIndex,
      detail,
      contextVariation: buildContextVariation(step, callIndex, contextRandom),
      outputTokens: countTokens(detail),
    };

    return new Promise<MockProviderResponse>((resolve, reject) => {
      // `keepProcessAlive: true`, not `false`. This timer's callback is what settles the
      // promise the caller is `await`ing — foreground work, not ordinary background
      // telemetry (`platform/telemetry-sdk/src/scheduler.ts`'s own `ScheduleOptions` doc).
      // With `false` under the default `systemScheduler`, the timer is `unref()`'d and a
      // short-lived script whose only remaining work is this `await` can exit 0 before the
      // timer ever fires — no rejection, no resolution, no error, just an abandoned await.
      // The timer is always bounded by `delay`, so keeping the process alive for it can
      // never hang a caller that awaits `invoke()`.
      this.scheduler.schedule(
        () => {
          if (failed) reject(new MockProviderFailure(step, callIndex, stats));
          else resolve(response);
        },
        delay,
        { keepProcessAlive: true },
      );
    });
  }

  private deriveSeed(seed: number, step: string, callIndex: number, salt: string): number {
    // `|` cannot appear inside `callIndex` (a number) or `salt` (a fixed internal literal),
    // so the only collision risk is a `step` name containing `|` itself — accepted, since
    // nothing today gives `MockAgent` a reason to name a step that way.
    return (seed ^ hashToSeed(`${step}|${callIndex}|${salt}`)) >>> 0;
  }
}
