import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INGEST_LIMITS } from '@lengentic/shared';
import { Controller, Post, HttpCode, HttpStatus, Body } from '@nestjs/common';
import { configureBodyParser } from './configure-body-parser';

/**
 * §12 request-level limits, exercised against a REAL Express body parser and the real
 * `bodyParserErrorHandler` middleware — not `Test.createTestingModule`'s default pipeline,
 * which never sees this file (`telemetry.controller.spec.ts` builds its testing module
 * without calling `configureBodyParser`, exactly so it stays about routing, not this).
 *
 * A trivial echo controller stands in for the real one: what's under test is the HTTP
 * pipeline in front of any controller, not `TelemetryEventsController` itself.
 */
@Controller('echo')
class EchoController {
  @Post()
  @HttpCode(HttpStatus.OK)
  echo(@Body() body: unknown): unknown {
    return body;
  }
}

describe('configureBodyParser', () => {
  let app: NestExpressApplication;

  afterEach(async () => {
    await app.close();
  });

  async function buildApp(): Promise<NestExpressApplication> {
    const moduleRef = await Test.createTestingModule({ controllers: [EchoController] }).compile();
    const built = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureBodyParser(built);
    await built.init();
    return built;
  }

  it('accepts a well-formed JSON body under the size limit', async () => {
    app = await buildApp();

    const response = await request(app.getHttpServer()).post('/echo').send({ a: 1 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ a: 1 });
  });

  it('rejects a body over the 5MB request-level limit with HTTP 400, not the platform default 413', async () => {
    app = await buildApp();
    const oversized = 'x'.repeat(INGEST_LIMITS.maxRequestBodyBytes + 1_000);

    const response = await request(app.getHttpServer())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: oversized }));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
  });

  it('rejects a body that is not valid JSON with HTTP 400', async () => {
    app = await buildApp();

    const response = await request(app.getHttpServer())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{not valid json');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
  });
});
