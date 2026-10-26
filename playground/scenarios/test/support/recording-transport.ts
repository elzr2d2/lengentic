/**
 * A `TelemetryTransport` that records every envelope instead of sending it anywhere —
 * offline, deterministic, and the seam the cross-scenario id test observes at.
 *
 * Built against `TelemetryTransport`'s own exported type rather than importing
 * `TelemetryEventEnvelope` from `@lengentic/shared`: the Playground may reach
 * `platform/telemetry-sdk` and nothing else in `platform/`
 * (`playground-not-to-other-platform-packages`, `pnpm check:boundaries`).
 *
 * A copy of `playground/scenarios/repeated-failure/test/support/recording-transport.ts` —
 * each test directory owns its own rather than reaching into a sibling scenario's tests.
 */
import type { TelemetryTransport, TransportResult } from '../../../index';

type Batch = Parameters<TelemetryTransport['send']>[0];
export type RecordedEnvelope = Batch[number];

export class RecordingTransport implements TelemetryTransport {
  private readonly batches: RecordedEnvelope[][] = [];

  get allEvents(): RecordedEnvelope[] {
    return this.batches.flat();
  }

  send(events: Batch): Promise<TransportResult> {
    this.batches.push([...events]);
    return Promise.resolve({ outcome: 'delivered', response: null });
  }
}
