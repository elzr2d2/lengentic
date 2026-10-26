import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Recommendation, RecommendationListView } from '@lengentic/shared';

import { RecommendationsController } from './recommendations.controller';
import type { RecommendationsService } from './recommendations.service';

/**
 * Seam: the one handler, with `RecommendationsService` faked. The controller does transport
 * only, so the only behaviour of its own it has is the 404 — everything else is pass-through
 * and is tested where it lives, in `recommendations.service.spec.ts`.
 *
 * The pipes are deliberately NOT exercised here: calling a handler as a plain method skips
 * Nest's pipe chain entirely, so an assertion about a rejected status would pass with the
 * pipe deleted. `RecommendationStatusPatchSchema` is tested directly in
 * `platform/shared/test/contract/recommendation.spec.ts`, and the wiring is an integration
 * concern.
 */

const DISMISSED = {
  id: 'rec-1',
  status: 'DISMISSED',
  statusNote: 'known trade-off',
} as unknown as Recommendation;

function controllerOver(service: Partial<RecommendationsService>): RecommendationsController {
  return new RecommendationsController(service as RecommendationsService);
}

describe('RecommendationsController', () => {
  it('returns what the service produced, unchanged', async () => {
    const controller = controllerOver({ setStatus: () => Promise.resolve(DISMISSED) });

    await expect(
      controller.setStatus('rec-1', { status: 'DISMISSED', note: 'known trade-off' }),
    ).resolves.toStrictEqual(DISMISSED);
  });

  it('passes the id and the parsed patch through to the service', async () => {
    const setStatus = vi.fn(() => Promise.resolve(DISMISSED));
    const controller = controllerOver({ setStatus });

    await controller.setStatus('rec-1', { status: 'OPEN' });

    expect(setStatus).toHaveBeenCalledWith('rec-1', { status: 'OPEN' });
  });

  it('turns an unknown recommendation into a 404 that names no id (ERR-4)', async () => {
    const controller = controllerOver({ setStatus: () => Promise.resolve(undefined) });

    await expect(controller.setStatus('nope', { status: 'DISMISSED' })).rejects.toThrow(
      NotFoundException,
    );
    await expect(controller.setStatus('nope', { status: 'DISMISSED' })).rejects.toThrow(
      'Recommendation not found',
    );
  });
});

describe('RecommendationsController.list', () => {
  const PAGE = {
    recommendations: [DISMISSED],
    limit: 50,
    offset: 0,
    hasMore: false,
  } as RecommendationListView;

  it('returns the page the service produced, unchanged', async () => {
    const controller = controllerOver({ list: () => Promise.resolve(PAGE) });

    await expect(
      controller.list({ limit: 50, offset: 0, category: 'DETERMINISTIC_CANDIDATE' }),
    ).resolves.toStrictEqual(PAGE);
  });

  it('passes the parsed window through rather than substituting a default of its own', async () => {
    const list = vi.fn(() => Promise.resolve(PAGE));
    const controller = controllerOver({ list });

    await controller.list({ limit: 10, offset: 40, category: 'DETERMINISTIC_CANDIDATE' });

    expect(list).toHaveBeenCalledWith({
      limit: 10,
      offset: 40,
      category: 'DETERMINISTIC_CANDIDATE',
    });
  });
});

describe('RecommendationsController.list — category routing', () => {
  it('defaults to the §20.1 read, so a caller written before §20.2 keeps its envelope', async () => {
    const list = vi.fn(() => Promise.resolve({} as RecommendationListView));
    const listRepeatedFailedActions = vi.fn();
    const controller = controllerOver({ list, listRepeatedFailedActions });

    await controller.list({ limit: 50, offset: 0, category: 'DETERMINISTIC_CANDIDATE' });

    expect(list).toHaveBeenCalledTimes(1);
    expect(listRepeatedFailedActions).not.toHaveBeenCalled();
  });

  it('routes REPEATED_FAILED_ACTION to the §20.2 read and never to the §20.1 one', async () => {
    const list = vi.fn();
    const listRepeatedFailedActions = vi.fn(() => Promise.resolve({}));
    const controller = controllerOver({
      list,
      listRepeatedFailedActions: listRepeatedFailedActions as never,
    });

    await controller.list({ limit: 50, offset: 0, category: 'REPEATED_FAILED_ACTION' });

    expect(listRepeatedFailedActions).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });
});
