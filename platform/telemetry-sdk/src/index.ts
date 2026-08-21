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
  CompleteInput,
  RunHandle,
  StartRunInput,
  StartStepInput,
  StepHandle,
} from './handles';

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
