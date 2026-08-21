import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RunsController } from './runs.controller';
import type { RunsService } from './runs.service';
import type { RunDetailView, RunListView } from '@lengentic/shared/read';

/**
 * Seam: `RunsController`'s two handlers, with `RunsService` faked. The controller does
 * transport only, so the only behaviour of its own it has is the 404 — everything else is
 * pass-through and is tested where it lives, in `runs.service.spec.ts`.
 *
 * The pipes are deliberately NOT exercised here: calling a handler as a plain method skips
 * Nest's pipe chain entirely, so an assertion about `limit` defaulting would pass with the
 * pipe deleted. The schema those pipes run is tested directly in the read model's own spec, and the
 * wiring is an integration concern (`platform/api/test/**`, owned by `p2.integration-tests`).
 */
const EMPTY_PAGE: RunListView = { runs: [], limit: 50, offset: 0, hasMore: false };

const RUN_DETAIL: RunDetailView = {
  id: 'run-1',
  traceId: 'run-1',
  workflowName: 'checkout-agent',
  workflowVersion: '1.4.0',
  status: 'STALE',
  startedAt: '2026-08-21T11:00:00.000Z',
  completedAt: null,
  receivedAt: '2026-08-21T11:00:00.000Z',
  lastEventAt: '2026-08-21T11:00:00.000Z',
  metadata: null,
  steps: [],
};

function controllerOver(service: Partial<RunsService>): RunsController {
  return new RunsController(service as unknown as RunsService);
}

describe('RunsController', () => {
  it('returns the page the service produced, unchanged', async () => {
    const page: RunListView = { ...EMPTY_PAGE, limit: 10, offset: 20, hasMore: true };
    const controller = controllerOver({ list: () => Promise.resolve(page) });

    await expect(controller.list({ limit: 10, offset: 20 })).resolves.toStrictEqual(page);
  });

  it('passes the parsed query through to the service', async () => {
    // Observed through the service's own argument rather than through a spy: the fake
    // answers with the query it was handed, so a controller that substituted its own page
    // parameters could not produce this result.
    const controller = controllerOver({
      list: (query) => Promise.resolve({ ...EMPTY_PAGE, limit: query.limit, offset: query.offset }),
    });

    const page = await controller.list({ limit: 7, offset: 14 });

    expect(page.limit).toBe(7);
    expect(page.offset).toBe(14);
  });

  it('returns the run detail the service produced, unchanged', async () => {
    const controller = controllerOver({ findById: () => Promise.resolve(RUN_DETAIL) });

    await expect(controller.detail('run-1')).resolves.toStrictEqual(RUN_DETAIL);
  });

  it('reports 404 when the service has no such run', async () => {
    const controller = controllerOver({ findById: () => Promise.resolve(undefined) });

    await expect(controller.detail('run-missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not put the requested id in the 404 body', async () => {
    // ERR-4: no internal identifier in an API response body.
    const controller = controllerOver({ findById: () => Promise.resolve(undefined) });

    const error = await controller.detail('run-missing').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundException);
    expect(JSON.stringify((error as NotFoundException).getResponse())).not.toContain('run-missing');
  });
});
