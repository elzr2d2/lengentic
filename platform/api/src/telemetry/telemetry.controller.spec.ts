import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import { INGEST_LIMITS, type IngestResponse } from '@lengentic/shared';
import { TelemetryEventsController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';

/**
 * Nest types `getHttpServer()` as `any`, which `no-unsafe-argument` rejects at the supertest
 * call. The invariant is externally proven — the Express adapter's server IS an
 * `http.Server` — so the assertion is made once here rather than at each call site (same
 * pattern as `test/health.integration.spec.ts`'s `httpServer`).
 */
const httpServer = (app: INestApplication): Server => app.getHttpServer() as Server;

/**
 * Wiring only: is the route actually `POST /telemetry/events` (main.ts's global `v1` prefix
 * makes that `/v1/telemetry/events`), does it return the service's `IngestResponse`
 * verbatim, and does the request-level `IngestRequestSchema` gate (empty/oversized `events`)
 * reject with HTTP 400 before the service is ever called. `TelemetryService` itself — the
 * merge/validation/idempotency logic — is `telemetry.service.spec.ts`'s job; it is faked
 * here on purpose.
 */
describe('TelemetryEventsController', () => {
  let app: INestApplication;
  let received: unknown;
  let receivedDropped: number | undefined;

  const fakeResponse: IngestResponse = {
    batchId: 'batch-1',
    accepted: 1,
    duplicate: 0,
    rejected: 0,
    results: [{ eventId: 'evt-1', status: 'ACCEPTED' }],
  };

  /** A batch of one that the request-level schema accepts, so only the field under test varies. */
  const wellFormedEvent = {
    eventId: 'evt-1',
    schemaVersion: '1',
    type: 'run.started',
    entityId: 'run-1',
    runId: 'run-1',
    occurredAt: '2026-08-18T10:00:00.000Z',
    payload: { workflowName: 'wf', workflowVersion: '1.0.0' },
  };

  beforeEach(async () => {
    received = undefined;
    receivedDropped = undefined;
    const moduleRef = await Test.createTestingModule({
      controllers: [TelemetryEventsController],
      providers: [
        {
          provide: TelemetryService,
          useValue: {
            ingest: (events: unknown, droppedSinceLastBatch?: number) => {
              received = events;
              receivedDropped = droppedSinceLastBatch;
              return Promise.resolve(fakeResponse);
            },
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with the service response for a well-formed batch', async () => {
    const event = {
      eventId: 'evt-1',
      schemaVersion: '1',
      type: 'run.started',
      entityId: 'run-1',
      runId: 'run-1',
      occurredAt: '2026-08-18T10:00:00.000Z',
      payload: { workflowName: 'wf', workflowVersion: '1.0.0' },
    };

    const response = await request(httpServer(app))
      .post('/telemetry/events')
      .send({ events: [event] });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(fakeResponse);
    expect(received).toEqual([event]);
  });

  it('rejects an empty events array at the request level with HTTP 400, before the service runs', async () => {
    const response = await request(httpServer(app)).post('/telemetry/events').send({ events: [] });

    expect(response.status).toBe(400);
    expect(received).toBeUndefined();
  });

  it('rejects a request body missing the events field entirely with HTTP 400', async () => {
    const response = await request(httpServer(app)).post('/telemetry/events').send({});

    expect(response.status).toBe(400);
    expect(received).toBeUndefined();
  });

  it('rejects a batch over the 500-event limit at the request level with HTTP 400, before the service runs', async () => {
    const events = Array.from({ length: INGEST_LIMITS.maxEventsPerBatch + 1 }, (_, i) => ({
      eventId: `evt-${i}`,
      schemaVersion: '1',
      type: 'run.started',
      entityId: `run-${i}`,
      runId: `run-${i}`,
      occurredAt: '2026-08-18T10:00:00.000Z',
      payload: { workflowName: 'wf', workflowVersion: '1.0.0' },
    }));

    const response = await request(httpServer(app)).post('/telemetry/events').send({ events });

    expect(response.status).toBe(400);
    expect(received).toBeUndefined();
  });

  /**
   * R4 (Builder finding raised in repair attempt 1's handoff; decision settled by the
   * Coordinator for repair attempt 2). `droppedSinceLastBatch` was `z.number().int()
   * .nonnegative()` with no upper bound, and lands in `Run.droppedTelemetryEventCount`
   * (Prisma `Int?`, Postgres `int4`). An over-int4 value raised SQLSTATE 22003 from
   * `incrementDroppedCount` — which runs LAST in `TelemetryService.ingest`, after every
   * event in the batch has already committed — so the caller got an HTTP 500 with no
   * per-event results for work that HAD landed, and every retry of the identical batch
   * threw again: the same permanent-poison shape as R1, one layer up.
   *
   * It is request-level, not event-level: the field is a property of the batch, not of any
   * event, so `classifyEvent` is not in a position to screen it. Rejected through the
   * mechanism its own sibling `events` already uses — a bound in `IngestRequestSchema`,
   * surfaced as `REQUEST_ERROR_CODES`' HTTP 400 by `ZodValidationPipe`. Not clamped: a
   * clamp would store a number the client never reported, and this field's whole reason to
   * exist is telling the truth about how many events were lost.
   *
   * The literals below are Postgres's own `int4` range, not a constant read back out of the
   * code under test, so a wrong bound in the schema cannot make these tests agree with it.
   */
  const POSTGRES_INT4_MAX = 2_147_483_647;

  it('rejects a droppedSinceLastBatch above the int4 ceiling at the request level with HTTP 400, before the service runs', async () => {
    const response = await request(httpServer(app))
      .post('/telemetry/events')
      .send({ events: [wellFormedEvent], droppedSinceLastBatch: POSTGRES_INT4_MAX + 1 });

    expect(response.status).toBe(400);
    // Not a 500, and not an unhandled throw: the batch is refused whole, with a verdict, at
    // the boundary — nothing reaches the write path that could half-commit it.
    expect(response.status).not.toBe(500);
    expect(received).toBeUndefined();
    expect(receivedDropped).toBeUndefined();
  });

  it('accepts a droppedSinceLastBatch exactly AT the int4 ceiling and passes it to the service', async () => {
    const response = await request(httpServer(app))
      .post('/telemetry/events')
      .send({ events: [wellFormedEvent], droppedSinceLastBatch: POSTGRES_INT4_MAX });

    expect(response.status).toBe(200);
    expect(receivedDropped).toBe(POSTGRES_INT4_MAX);
  });

  // The two behaviours the bound must not disturb (ADR 0014 decision 2 — absence is "not
  // reported", NULL, and is a different thing from a reported zero).
  it('leaves an omitted droppedSinceLastBatch undefined at the service seam', async () => {
    const response = await request(httpServer(app))
      .post('/telemetry/events')
      .send({ events: [wellFormedEvent] });

    expect(response.status).toBe(200);
    expect(receivedDropped).toBeUndefined();
  });

  it('still passes a reported zero through as 0, not as absence', async () => {
    const response = await request(httpServer(app))
      .post('/telemetry/events')
      .send({ events: [wellFormedEvent], droppedSinceLastBatch: 0 });

    expect(response.status).toBe(200);
    expect(receivedDropped).toBe(0);
    expect(receivedDropped).not.toBeUndefined();
  });

  it('still rejects a negative droppedSinceLastBatch — the bound is added to nonnegative, not instead of it', async () => {
    const response = await request(httpServer(app))
      .post('/telemetry/events')
      .send({ events: [wellFormedEvent], droppedSinceLastBatch: -1 });

    expect(response.status).toBe(400);
    expect(received).toBeUndefined();
  });
});
