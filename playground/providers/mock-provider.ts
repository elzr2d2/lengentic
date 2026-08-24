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
import { systemScheduler, type Scheduler } from '@lengentic/telemetry-sdk';

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

export interface MockProviderResponse {
  readonly step: string;
  readonly callIndex: number;
  /** Deterministic filler standing in for a real provider's generated content. */
  readonly detail: string;
  readonly contextVariation: MockProviderContextVariation;
}

/**
 * Raised when the configured failure behaviour selects failure for a call — mirrors a real
 * provider call rejecting, so `MockAgent` exercises the same failure shape it would see
 * from a network provider, without a network.
 */
export class MockProviderFailure extends Error {
  readonly step: string;

  readonly callIndex: number;

  constructor(step: string, callIndex: number) {
    super(`MockProvider: simulated failure at step "${step}" (call ${callIndex})`);
    this.name = 'MockProviderFailure';
    this.step = step;
    this.callIndex = callIndex;
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

function validateConfig(config: MockProviderConfig): void {
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

    const response: MockProviderResponse = {
      step,
      callIndex,
      detail: buildDetail(step, callIndex, outcomeRandom),
      contextVariation: buildContextVariation(step, callIndex, contextRandom),
    };

    return new Promise<MockProviderResponse>((resolve, reject) => {
      this.scheduler.schedule(
        () => {
          if (failed) reject(new MockProviderFailure(step, callIndex));
          else resolve(response);
        },
        delay,
        { keepProcessAlive: false },
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
