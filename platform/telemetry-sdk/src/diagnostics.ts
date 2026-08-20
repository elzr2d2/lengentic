/**
 * §16 "Silent": the SDK NEVER throws into host code. Every failure it would otherwise have
 * thrown becomes one of these records, handed to a configurable sink and counted.
 *
 * The default sink is silent — not "logs to stderr". A host that has not asked for SDK
 * diagnostics gets none; an agent's stderr is not LenGentic's to spend.
 */
export type TelemetryDiagnosticCode =
  /** An event failed the wire contract or could not be serialized. Dropped. */
  | 'event_invalid'
  /** An event exceeded INGEST_LIMITS.maxEventPayloadBytes. Dropped. */
  | 'event_too_large'
  /** The bounded buffer overflowed and the oldest events were dropped. */
  | 'queue_overflow'
  /** One delivery attempt failed. Retried if the failure was retryable and budget remains. */
  | 'delivery_failed'
  /** A batch was given up on: retries exhausted, or the failure was permanent. */
  | 'batch_dropped'
  /** shutdown() hit its bound before the queue drained. */
  | 'shutdown_timeout'
  /** An event was recorded after shutdown(). Dropped. */
  | 'client_closed'
  /** complete() was called twice for the same entity. The second call is ignored. */
  | 'completion_ignored';

export interface TelemetryDiagnostic {
  readonly code: TelemetryDiagnosticCode;
  readonly message: string;
  /** How many events this diagnostic accounts for. Zero when it is not about events. */
  readonly eventCount: number;
  /** 1-based delivery attempt, or 0 when the diagnostic is not about a delivery attempt. */
  readonly attempt: number;
}

export type DiagnosticSink = (diagnostic: TelemetryDiagnostic) => void;

/** The default. Silent means silent. */
export const silentSink: DiagnosticSink = () => undefined;

/**
 * `unknown` from a catch clause (TS-8 `useUnknownInCatchVariables`) rendered as a string
 * without going through `[object Object]` (OBS-3).
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'number' || typeof error === 'boolean') return String(error);
  return 'non-Error thrown';
}
