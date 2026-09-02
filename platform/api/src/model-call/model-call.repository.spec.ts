import { describe, expect, it, vi } from 'vitest';
import { ModelCallRepository } from './model-call.repository';
import type { ModelCallWrite } from './model-call-record';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Seam: the exact query this repository sends Prisma — mirrors `decisions.repository.spec.ts`
 * (see that file's header for why this matters more than it looks).
 */
interface ModelCallUpsertArgs {
  readonly where: { readonly id: string };
  readonly create: Record<string, unknown>;
  readonly update: Record<string, unknown>;
}

function fakePrismaService(): {
  prisma: PrismaService;
  modelCall: { upsert: ReturnType<typeof vi.fn<(args: ModelCallUpsertArgs) => Promise<void>>> };
} {
  const modelCall = {
    upsert: vi.fn<(args: ModelCallUpsertArgs) => Promise<void>>(() => Promise.resolve()),
  };
  const prisma = { client: { modelCall } } as unknown as PrismaService;
  return { prisma, modelCall };
}

function write(overrides: Partial<ModelCallWrite> = {}): ModelCallWrite {
  return {
    id: 'mc-1',
    runId: 'run-9',
    stepId: 'step-1',
    provider: 'anthropic',
    model: 'claude-opus-5',
    latencyMs: 812,
    inputTokens: 1200,
    outputTokens: 340,
    status: 'ok',
    metadata: null,
    ...overrides,
  };
}

describe('ModelCallRepository.record', () => {
  it('keys the write on the entity id', async () => {
    const { prisma, modelCall } = fakePrismaService();

    await new ModelCallRepository(prisma).record(write({ id: 'mc-42' }));

    expect(modelCall.upsert.mock.calls[0]?.[0].where).toStrictEqual({ id: 'mc-42' });
  });

  it('create and update carry the same full column bag — one writer, no attestation-style split', async () => {
    const { prisma, modelCall } = fakePrismaService();

    await new ModelCallRepository(prisma).record(write());

    const call = modelCall.upsert.mock.calls[0]?.[0];
    const { id: _id, ...createRest } = call?.create ?? {};
    expect(createRest).toStrictEqual(call?.update);
    expect(call?.create).toMatchObject({
      runId: 'run-9',
      stepId: 'step-1',
      provider: 'anthropic',
      model: 'claude-opus-5',
      inputTokens: 1200,
      outputTokens: 340,
      status: 'ok',
    });
  });

  it('writes in one statement — replaying the same id converges without a prior read', async () => {
    const { prisma, modelCall } = fakePrismaService();
    const repository = new ModelCallRepository(prisma);

    await repository.record(write());
    await repository.record(write());

    expect(modelCall.upsert).toHaveBeenCalledTimes(2);
  });
});
