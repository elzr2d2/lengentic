/**
 * The public entry of `@lengentic/telemetry-sdk`. Deep imports into `src/` are an
 * architectural violation (`playground-sdk-public-entry-only`, `pnpm check:boundaries`),
 * so everything a consumer may rely on is here and nothing else is.
 */
export { createTelemetryClient } from './client';
export type { TelemetryClient, TelemetryStats } from './client';

export { TELEMETRY_DEFAULTS, TelemetryConfigError } from './config';
export type { TelemetryConfig } from './config';

export type {
  AttestOutcomeInput,
  CompleteInput,
  CrossProcessAttestOutcomeInput,
  DecisionHandle,
  RecordDecisionInput,
  RecordErrorInput,
  RecordModelCallInput,
  RecordToolCallInput,
  RunHandle,
  StartRunInput,
  StartStepInput,
  StepHandle,
} from './handles';

// §15 payload safety. `createPayloadSafety` and `capField` are exported because they are
// the sanitizer a caller needs to reproduce the SDK's own behaviour — most usefully to
// compute §20.2's caller-owned `inputFingerprint` over data that provably never contained
// a secret. `defaultRedactor` is exported so a caller writing their own `redact` can see
// exactly what the floor beneath it already covers.
export {
  createPayloadSafety,
  defaultRedactor,
  fingerprintOf,
  DEFAULT_MAX_FIELD_BYTES,
  MAX_FIELD_BYTES_CEILING,
  MIN_FIELD_BYTES,
  REDACTED,
  REPLACED_KEY,
  TRUNCATION_KEY,
} from './payload-safety';
export type { PayloadSafety, PayloadSafetyOptions, Redactor, SafeToolIO } from './payload-safety';

export { silentSink } from './diagnostics';
export type { DiagnosticSink, TelemetryDiagnostic, TelemetryDiagnosticCode } from './diagnostics';

export { createHttpTransport } from './transport';
export type { HttpTransportOptions, TelemetryTransport, TransportResult } from './transport';

export { SeededClock, systemClock } from './clock';
export type { Clock } from './clock';

export { SeededIdGenerator, systemIdGenerator } from './ids';
export type { IdGenerator } from './ids';

export { systemScheduler } from './scheduler';
export type { CancelTimer, Scheduler } from './scheduler';
