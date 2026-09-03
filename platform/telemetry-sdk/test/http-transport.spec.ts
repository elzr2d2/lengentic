import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { IngestRequestSchema, TELEMETRY_INGEST_PATH } from '@lengentic/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { createHttpTransport } from '../src/index';

/**
 * Seam: `createHttpTransport` against a real HTTP server on a real socket. Not a fetch mock
 * — the thing under test IS the HTTP behaviour, and a double for it would assert that the
 * double works (TEST-3's rule, applied one level down).
 *
 * Expected values: the status-class rules stated in `src/transport.ts` and §12's endpoint
 * and request shape, the latter checked with `IngestRequestSchema` from `@lengentic/shared`.
 */
interface Recorded {
  method: string | undefined;
  url: string | undefined;
  body: string;
}

let server: Server | null = null;

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse, recorded: Recorded) => void,
): Promise<{ endpoint: string; recorded: Recorded }> {
  const recorded: Recorded = { method: undefined, url: undefined, body: '' };
  const created = createServer((request, response) => {
    recorded.method = request.method;
    recorded.url = request.url;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      recorded.body = Buffer.concat(chunks).toString('utf8');
      handler(request, response, recorded);
    });
  });
  server = created;
  await new Promise<void>((listening) => {
    created.listen(0, '127.0.0.1', listening);
  });
  const address = created.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${address.port}`, recorded };
}

afterEach(async () => {
  const running = server;
  server = null;
  if (running === null) return;
  await new Promise<void>((closed) => {
    running.close(() => closed());
  });
});

const event = {
  eventId: 'e1',
  schemaVersion: '1',
  type: 'run.started',
  entityId: 'r1',
  runId: 'r1',
  occurredAt: '2026-08-21T10:00:00.000Z',
  payload: { workflowName: 'w', workflowVersion: 'v' },
} as const;

function send(endpoint: string): ReturnType<ReturnType<typeof createHttpTransport>['send']> {
  return createHttpTransport({ endpoint }).send([event], { signal: new AbortController().signal });
}

describe('the HTTP transport', () => {
  it('POSTs a §12 batch to §12s endpoint', async () => {
    const { endpoint, recorded } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ batchId: 'b1', accepted: 1, duplicate: 0, rejected: 0, results: [] }),
      );
    });

    const result = await send(endpoint);

    expect(recorded.method).toBe('POST');
    expect(recorded.url).toBe(TELEMETRY_INGEST_PATH);
    expect(IngestRequestSchema.safeParse(JSON.parse(recorded.body)).success).toBe(true);
    expect(result).toStrictEqual({
      outcome: 'delivered',
      response: { batchId: 'b1', accepted: 1, duplicate: 0, rejected: 0, results: [] },
    });
  });

  it('still counts a 2xx as delivered when the body cannot be understood', async () => {
    const { endpoint } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('not json at all');
    });

    // Retrying here would re-post events the server has already accepted (ASYNC-5).
    expect(await send(endpoint)).toStrictEqual({ outcome: 'delivered', response: null });
  });

  it.each([
    [408, 'retryable'],
    [425, 'retryable'],
    [429, 'retryable'],
    [500, 'retryable'],
    [503, 'retryable'],
    [400, 'permanent'],
    [401, 'permanent'],
    [404, 'permanent'],
    [413, 'permanent'],
  ])('maps HTTP %i to %s', async (status, outcome) => {
    const { endpoint } = await serve((_request, response) => {
      response.writeHead(status);
      response.end();
    });

    expect(await send(endpoint)).toStrictEqual({ outcome, detail: `HTTP ${status}` });
  });

  it('reports a refused connection as retryable rather than throwing', async () => {
    const { endpoint } = await serve((_request, response) => {
      response.writeHead(200);
      response.end('{}');
    });
    const running = server;
    server = null;
    await new Promise<void>((closed) => {
      running?.close(() => closed());
    });

    const result = await send(endpoint);

    expect(result.outcome).toBe('retryable');
  });

  it('serializes droppedSinceLastBatch beside events, and IngestRequestSchema accepts it', async () => {
    const { endpoint, recorded } = await serve((_request, response) => {
      response.writeHead(200);
      response.end('{}');
    });

    await createHttpTransport({ endpoint }).send([event], {
      signal: new AbortController().signal,
      droppedSinceLastBatch: 7,
    });

    const body: unknown = JSON.parse(recorded.body);
    expect(body).toMatchObject({ droppedSinceLastBatch: 7 });
    // The independent oracle: `@lengentic/shared` is the same schema the API validates
    // with, so a request it accepts here is one the API accepts.
    expect(IngestRequestSchema.safeParse(body).success).toBe(true);
  });

  it('omits the field entirely when the caller reported nothing — "not reported" is not 0', async () => {
    const { endpoint, recorded } = await serve((_request, response) => {
      response.writeHead(200);
      response.end('{}');
    });

    await send(endpoint); // no droppedSinceLastBatch option at all

    // `IngestRequestSchema` makes the field `.optional()` so a pre-field SDK reads as
    // `null` on the Dashboard. Emitting `0` here would manufacture a report nobody made.
    expect(Object.keys(JSON.parse(recorded.body) as object)).toStrictEqual(['events']);
  });

  it('sends a zero the caller DID report, rather than dropping it as falsy', async () => {
    const { endpoint, recorded } = await serve((_request, response) => {
      response.writeHead(200);
      response.end('{}');
    });

    await createHttpTransport({ endpoint }).send([event], {
      signal: new AbortController().signal,
      droppedSinceLastBatch: 0,
    });

    expect(JSON.parse(recorded.body)).toMatchObject({ droppedSinceLastBatch: 0 });
  });

  it('reports circular data as permanent — re-sending it cannot make it serializable', async () => {
    const { endpoint } = await serve((_request, response) => {
      response.writeHead(200);
      response.end('{}');
    });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = await createHttpTransport({ endpoint }).send([{ ...event, payload: circular }], {
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('permanent');
  });
});
