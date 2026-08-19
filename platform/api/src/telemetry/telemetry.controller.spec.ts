import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { IngestResponse } from '@lengentic/shared';
import { TelemetryEventsController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';

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

  const fakeResponse: IngestResponse = {
    batchId: 'batch-1',
    accepted: 1,
    duplicate: 0,
    rejected: 0,
    results: [{ eventId: 'evt-1', status: 'ACCEPTED' }],
  };

  beforeEach(async () => {
    received = undefined;
    const moduleRef = await Test.createTestingModule({
      controllers: [TelemetryEventsController],
      providers: [
        {
          provide: TelemetryService,
          useValue: {
            ingest: (events: unknown) => {
              received = events;
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

    const response = await request(app.getHttpServer())
      .post('/telemetry/events')
      .send({ events: [event] });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(fakeResponse);
    expect(received).toEqual([event]);
  });

  it('rejects an empty events array at the request level with HTTP 400, before the service runs', async () => {
    const response = await request(app.getHttpServer())
      .post('/telemetry/events')
      .send({ events: [] });

    expect(response.status).toBe(400);
    expect(received).toBeUndefined();
  });

  it('rejects a request body missing the events field entirely with HTTP 400', async () => {
    const response = await request(app.getHttpServer()).post('/telemetry/events').send({});

    expect(response.status).toBe(400);
    expect(received).toBeUndefined();
  });
});
