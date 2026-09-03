import {
  IngestResponseSchema,
  TELEMETRY_INGEST_PATH,
  type IngestResponse,
  type TelemetryEventEnvelope,
} from '@lengentic/shared';

import { describeError } from './diagnostics';

/**
 * What one delivery attempt produced. A discriminated result rather than a thrown error:
 * "should this be retried" is transport knowledge, and an exception erases it.
 */
export type TransportResult =
  /** The batch reached the API. `response` is null when the body could not be understood. */
  | { readonly outcome: 'delivered'; readonly response: IngestResponse | null }
  /** Transient — worth another attempt inside the bounded retry budget. */
  | { readonly outcome: 'retryable'; readonly detail: string }
  /** Permanent — retrying re-sends a batch the far end has already refused. */
  | { readonly outcome: 'permanent'; readonly detail: string };

export interface TelemetryTransport {
  /**
   * Deliver one batch. Never called concurrently by the client. Implementations SHOULD
   * honour `signal`; the client bounds the attempt either way, so one that ignores it
   * cannot hang the host.
   *
   * `droppedSinceLastBatch` is ADDITIVE and OPTIONAL on purpose (ADR 0014 decision 2): a
   * transport written before the field existed keeps compiling and keeps working, and the
   * option arrives as `undefined` for anyone calling `send` directly. `0` and `undefined`
   * are different facts — see `createHttpTransport` below.
   */
  send(
    events: readonly TelemetryEventEnvelope[],
    options: {
      readonly signal: AbortSignal;
      /**
       * The sum of §16's five client-side drop counters NOT yet CARRIED BY a successfully
       * delivered batch. The client snapshots it once per batch and hands the same snapshot
       * to every retry of that batch, so a transport must not try to recompute or adjust it.
       *
       * The server folds each report as an ADDEND into a per-run running total
       * (`TelemetryRepository.incrementDroppedCount`). A transport that splits one `send`
       * into two requests therefore doubles the run's count while the client acknowledges
       * the snapshot once: send it in exactly one request, or not at all.
       */
      readonly droppedSinceLastBatch?: number | undefined;
    },
  ): Promise<TransportResult>;
}

export interface HttpTransportOptions {
  /** Base URL of the API, e.g. `http://localhost:3000`. The §12 path is appended. */
  readonly endpoint: string;
  readonly apiKey?: string | undefined;
}

/**
 * Retryable by status. 408/425/429 and every 5xx are the far end saying "not now"; any
 * other 4xx is the far end saying "not this", and §12's per-event results — not a retry —
 * are how a rejected event is learned about.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function readIngestResponse(response: Response): Promise<IngestResponse | null> {
  try {
    const parsed = IngestResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    // A 2xx whose body we cannot read still delivered the batch. The body is telemetry
    // about telemetry; losing it is not a delivery failure and must not trigger a retry
    // that would re-post events the server has already accepted (ASYNC-5).
    return null;
  }
}

export function createHttpTransport(options: HttpTransportOptions): TelemetryTransport {
  const url = new URL(TELEMETRY_INGEST_PATH, options.endpoint).toString();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.apiKey !== undefined) headers.authorization = `Bearer ${options.apiKey}`;

  return {
    async send(events, { signal, droppedSinceLastBatch }) {
      let body: string;
      try {
        // Omitted, never `0`, when the caller has no opinion: `IngestRequestSchema` makes
        // the field `.optional()` precisely so an SDK that predates it reads as "not
        // reported" (`RunSummary.droppedTelemetryEventCount: null`) rather than as a
        // silently-manufactured zero. A caller that DID report zero gets a zero on the wire.
        body = JSON.stringify(
          droppedSinceLastBatch === undefined ? { events } : { events, droppedSinceLastBatch },
        );
      } catch (error) {
        // Circular data, a BigInt, a getter that throws (§15). Re-sending cannot fix it.
        return { outcome: 'permanent', detail: `serialization failed: ${describeError(error)}` };
      }

      let response: Response;
      try {
        response = await fetch(url, { method: 'POST', headers, body, signal });
      } catch (error) {
        // Connection refused, DNS failure, abort. The API being down is the ordinary case.
        return { outcome: 'retryable', detail: `transport error: ${describeError(error)}` };
      }

      if (response.ok) {
        return { outcome: 'delivered', response: await readIngestResponse(response) };
      }
      const detail = `HTTP ${response.status}`;
      return isRetryableStatus(response.status)
        ? { outcome: 'retryable', detail }
        : { outcome: 'permanent', detail };
    },
  };
}
