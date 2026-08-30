import { INGEST_LIMITS } from '@lengentic/shared';

import { systemClock, type Clock } from './clock';
import { silentSink, type DiagnosticSink } from './diagnostics';
import { systemIdGenerator, type IdGenerator } from './ids';
import {
  DEFAULT_MAX_FIELD_BYTES,
  MAX_FIELD_BYTES_CEILING,
  MIN_FIELD_BYTES,
  type Redactor,
} from './payload-safety';
import { systemScheduler, type Scheduler } from './scheduler';
import { createHttpTransport, type TelemetryTransport } from './transport';

/**
 * §16: "Invalid SDK initialization config MAY fail fast with a clear error. That is a
 * programming error at startup, not a runtime telemetry event." This is the one error the
 * SDK throws, and it is thrown before any event can have been recorded.
 */
export class TelemetryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelemetryConfigError';
  }
}

export interface TelemetryConfig {
  /** Base URL of the API. Required unless `transport` is supplied. */
  readonly endpoint?: string | undefined;
  readonly apiKey?: string | undefined;
  /** §16 default: flush on interval (1s) or buffer size, whichever comes first. */
  readonly flushIntervalMs?: number | undefined;
  /** §16 default 100. Never above §12's 500 events per batch. */
  readonly maxBatchSize?: number | undefined;
  /** §16 "Bounded": the hard ceiling on the in-memory queue. Overflow drops oldest. */
  readonly maxQueueSize?: number | undefined;
  /** §16 "Retrying": FINITE. Attempts per batch are `maxRetries + 1`. */
  readonly maxRetries?: number | undefined;
  readonly initialBackoffMs?: number | undefined;
  readonly maxBackoffMs?: number | undefined;
  /** ASYNC-4: a call that can hang carries a bound. */
  readonly requestTimeoutMs?: number | undefined;
  /** How long `shutdown()` may spend draining before it gives up and resolves anyway. */
  readonly shutdownTimeoutMs?: number | undefined;
  /**
   * §15's redaction hook. Runs client-side, before transmission, on every arbitrary JSON
   * field. The shipped defaults (`Authorization`, `/api[_-]?key/i`, bearer tokens) run
   * AFTER this hook, so supplying one narrows nothing.
   */
  readonly redact?: Redactor | undefined;
  /** §15 default 32KB per field. Exceeding truncates and sets the `*Truncated` flag. */
  readonly maxFieldBytes?: number | undefined;
  /**
   * §15's opt-out. `false` disables ToolCall input/output capture entirely while retaining
   * timing and success data. Default `true`.
   */
  readonly captureToolIO?: boolean | undefined;
  readonly transport?: TelemetryTransport | undefined;
  readonly clock?: Clock | undefined;
  readonly idGenerator?: IdGenerator | undefined;
  readonly scheduler?: Scheduler | undefined;
  readonly onDiagnostic?: DiagnosticSink | undefined;
}

export interface ResolvedTelemetryConfig {
  readonly flushIntervalMs: number;
  readonly maxBatchSize: number;
  readonly maxQueueSize: number;
  readonly maxRetries: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly requestTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly redact: Redactor | undefined;
  readonly maxFieldBytes: number;
  readonly captureToolIO: boolean;
  readonly transport: TelemetryTransport;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly scheduler: Scheduler;
  readonly onDiagnostic: DiagnosticSink;
}

/** §16 states the first two. The rest are this package's defaults, documented in README.md. */
export const TELEMETRY_DEFAULTS = Object.freeze({
  flushIntervalMs: 1_000,
  maxBatchSize: 100,
  maxQueueSize: 10_000,
  maxRetries: 3,
  initialBackoffMs: 200,
  maxBackoffMs: 5_000,
  requestTimeoutMs: 5_000,
  shutdownTimeoutMs: 5_000,
  maxFieldBytes: DEFAULT_MAX_FIELD_BYTES,
  captureToolIO: true,
});

function positiveInt(
  name: string,
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > max) {
    throw new TelemetryConfigError(`${name} must be an integer between 1 and ${max}`);
  }
  return resolved;
}

function nonNegativeInt(
  name: string,
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > max) {
    throw new TelemetryConfigError(`${name} must be an integer between 0 and ${max}`);
  }
  return resolved;
}

function boundedInt(
  name: string,
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new TelemetryConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return resolved;
}

function resolveTransport(config: TelemetryConfig): TelemetryTransport {
  if (config.transport !== undefined) return config.transport;
  if (config.endpoint === undefined || config.endpoint === '') {
    throw new TelemetryConfigError('endpoint is required unless a transport is supplied');
  }
  let base: URL;
  try {
    base = new URL(config.endpoint);
  } catch {
    throw new TelemetryConfigError(`endpoint is not an absolute URL: ${config.endpoint}`);
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new TelemetryConfigError(`endpoint must be http or https, received ${base.protocol}`);
  }
  return createHttpTransport({ endpoint: config.endpoint, apiKey: config.apiKey });
}

export function resolveConfig(config: TelemetryConfig): ResolvedTelemetryConfig {
  const maxBatchSize = positiveInt(
    'maxBatchSize',
    config.maxBatchSize,
    TELEMETRY_DEFAULTS.maxBatchSize,
    INGEST_LIMITS.maxEventsPerBatch,
  );
  const maxQueueSize = positiveInt(
    'maxQueueSize',
    config.maxQueueSize,
    TELEMETRY_DEFAULTS.maxQueueSize,
    Number.MAX_SAFE_INTEGER,
  );
  if (maxQueueSize < maxBatchSize) {
    throw new TelemetryConfigError('maxQueueSize must be at least maxBatchSize');
  }
  const initialBackoffMs = positiveInt(
    'initialBackoffMs',
    config.initialBackoffMs,
    TELEMETRY_DEFAULTS.initialBackoffMs,
    Number.MAX_SAFE_INTEGER,
  );
  const maxBackoffMs = positiveInt(
    'maxBackoffMs',
    config.maxBackoffMs,
    TELEMETRY_DEFAULTS.maxBackoffMs,
    Number.MAX_SAFE_INTEGER,
  );
  if (maxBackoffMs < initialBackoffMs) {
    throw new TelemetryConfigError('maxBackoffMs must be at least initialBackoffMs');
  }

  return {
    flushIntervalMs: positiveInt(
      'flushIntervalMs',
      config.flushIntervalMs,
      TELEMETRY_DEFAULTS.flushIntervalMs,
      Number.MAX_SAFE_INTEGER,
    ),
    maxBatchSize,
    maxQueueSize,
    // Bounded by 100 rather than by MAX_SAFE_INTEGER: "retry until it works" is the defect
    // §16 forbids, and a budget large enough to be indistinguishable from unbounded is the
    // same defect written differently.
    maxRetries: nonNegativeInt('maxRetries', config.maxRetries, TELEMETRY_DEFAULTS.maxRetries, 100),
    initialBackoffMs,
    maxBackoffMs,
    requestTimeoutMs: positiveInt(
      'requestTimeoutMs',
      config.requestTimeoutMs,
      TELEMETRY_DEFAULTS.requestTimeoutMs,
      Number.MAX_SAFE_INTEGER,
    ),
    shutdownTimeoutMs: positiveInt(
      'shutdownTimeoutMs',
      config.shutdownTimeoutMs,
      TELEMETRY_DEFAULTS.shutdownTimeoutMs,
      Number.MAX_SAFE_INTEGER,
    ),
    // A per-field cap above §12's per-event cap cannot hold — the event would be dropped
    // whole before the field cap mattered. Below MIN_FIELD_BYTES a truncated record has no
    // room for its own marker.
    maxFieldBytes: boundedInt(
      'maxFieldBytes',
      config.maxFieldBytes,
      TELEMETRY_DEFAULTS.maxFieldBytes,
      MIN_FIELD_BYTES,
      MAX_FIELD_BYTES_CEILING,
    ),
    redact: config.redact,
    captureToolIO: config.captureToolIO ?? TELEMETRY_DEFAULTS.captureToolIO,
    transport: resolveTransport(config),
    clock: config.clock ?? systemClock,
    idGenerator: config.idGenerator ?? systemIdGenerator,
    scheduler: config.scheduler ?? systemScheduler,
    onDiagnostic: config.onDiagnostic ?? silentSink,
  };
}
