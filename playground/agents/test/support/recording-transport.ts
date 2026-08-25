/**
 * A `TelemetryTransport` that records every envelope instead of sending it anywhere —
 * offline, deterministic, and the seam these tests observe `MockAgent`'s telemetry output
 * at. A small local copy of `playground/determinism/test/support/recording-transport.ts`
 * rather than a cross-directory import into a sibling package's test-only material — the
 * same reasoning `playground/providers/test/support/fake-scheduler.ts` gives for not
 * importing `platform/telemetry-sdk/test/support/fake-scheduler.ts` directly.
 *
 * Built against `TelemetryTransport`'s own exported type rather than importing
 * `TelemetryEventEnvelope` from `@lengentic/shared`: the Playground may reach
 * `platform/telemetry-sdk` and nothing else in `platform/`
 * (`playground-not-to-other-platform-packages`, `pnpm check:boundaries`), and the envelope
 * type is derivable from the transport's own `send` signature without a second import.
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
