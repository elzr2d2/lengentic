import type { TelemetryEventEnvelope } from '@lengentic/shared';

import type { TelemetryTransport, TransportResult } from '../../src/transport';

export class RecordingTransport implements TelemetryTransport {
  readonly batches: TelemetryEventEnvelope[][] = [];

  constructor(
    private readonly result: TransportResult = { outcome: 'delivered', response: null },
  ) {}

  get allEvents(): TelemetryEventEnvelope[] {
    return this.batches.flat();
  }

  send(events: readonly TelemetryEventEnvelope[]): Promise<TransportResult> {
    this.batches.push([...events]);
    return Promise.resolve(this.result);
  }
}

/** A transport that always fails the way it was told to, and counts every attempt. */
export class FailingTransport implements TelemetryTransport {
  attempts = 0;

  constructor(private readonly result: TransportResult) {}

  send(): Promise<TransportResult> {
    this.attempts += 1;
    return Promise.resolve(this.result);
  }
}

/** A transport that throws synchronously — a badly written custom transport. */
export class ThrowingTransport implements TelemetryTransport {
  attempts = 0;

  send(): Promise<TransportResult> {
    this.attempts += 1;
    throw new Error('transport exploded');
  }
}

/** A transport that never settles and ignores the abort signal. The worst neighbour. */
export class HangingTransport implements TelemetryTransport {
  attempts = 0;

  abortsObserved = 0;

  send(
    _events: readonly TelemetryEventEnvelope[],
    options: { readonly signal: AbortSignal },
  ): Promise<TransportResult> {
    this.attempts += 1;
    options.signal.addEventListener('abort', () => {
      this.abortsObserved += 1;
    });
    return new Promise<TransportResult>(() => undefined);
  }
}

/**
 * Records what it was handed and holds every response open until the test releases it.
 * Lets a test observe the buffer while a delivery is genuinely in flight.
 */
export class GatedTransport implements TelemetryTransport {
  readonly batches: TelemetryEventEnvelope[][] = [];

  private readonly gates: Array<() => void> = [];

  get pending(): number {
    return this.gates.length;
  }

  send(events: readonly TelemetryEventEnvelope[]): Promise<TransportResult> {
    this.batches.push([...events]);
    return new Promise<TransportResult>((settle) => {
      this.gates.push(() => {
        settle({ outcome: 'delivered', response: null });
      });
    });
  }

  releaseAll(): void {
    for (const gate of this.gates.splice(0)) gate();
  }
}
