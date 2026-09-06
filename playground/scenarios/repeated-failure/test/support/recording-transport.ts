/**
 * A `TelemetryTransport` that records every envelope instead of sending it anywhere —
 * offline, deterministic, and the seam these tests observe the scenario's output at.
 *
 * Built against `TelemetryTransport`'s own exported type rather than importing
 * `TelemetryEventEnvelope` from `@lengentic/shared`: the Playground may reach
 * `platform/telemetry-sdk` and nothing else in `platform/`
 * (`playground-not-to-other-platform-packages`, `pnpm check:boundaries`), and the envelope
 * type is derivable from the transport's own `send` signature without a second import.
 *
 * A copy of `playground/scenarios/deterministic-decision/test/support/recording-transport.ts`
 * — each test directory owns its own, because every other directory's copy is outside this
 * packet's `allowed_paths` and a shared one would have to live somewhere this lane cannot
 * write.
 */
import type { TelemetryTransport, TransportResult } from '../../../../index';

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
