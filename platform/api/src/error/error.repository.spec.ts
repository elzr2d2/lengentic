import { describe, expect, it, vi } from 'vitest';
import { ErrorRepository } from './error.repository';
import type { ErrorRecordWrite } from './error-record';
import type { PrismaService } from '../prisma/prisma.service';

interface ErrorUpsertArgs {
  readonly where: { readonly id: string };
  readonly create: Record<string, unknown>;
  readonly update: Record<string, unknown>;
}

function fakePrismaService(): {
  prisma: PrismaService;
  error: { upsert: ReturnType<typeof vi.fn<(args: ErrorUpsertArgs) => Promise<void>>> };
} {
  const error = {
    upsert: vi.fn<(args: ErrorUpsertArgs) => Promise<void>>(() => Promise.resolve()),
  };
  const prisma = { client: { error } } as unknown as PrismaService;
  return { prisma, error };
}

function write(overrides: Partial<ErrorRecordWrite> = {}): ErrorRecordWrite {
  return {
    id: 'err-1',
    runId: 'run-9',
    stepId: 'step-1',
    type: 'TimeoutError',
    message: 'timed out',
    metadata: null,
    ...overrides,
  };
}

describe('ErrorRepository.record', () => {
  it('keys the write on the entity id', async () => {
    const { prisma, error } = fakePrismaService();

    await new ErrorRepository(prisma).record(write({ id: 'err-42' }));

    expect(error.upsert.mock.calls[0]?.[0].where).toStrictEqual({ id: 'err-42' });
  });

  it('carries type and message through', async () => {
    const { prisma, error } = fakePrismaService();

    await new ErrorRepository(prisma).record(write({ type: 'ToolTimeout', message: 'boom' }));

    expect(error.upsert.mock.calls[0]?.[0].create).toMatchObject({
      type: 'ToolTimeout',
      message: 'boom',
    });
  });

  it('create and update carry the same full column bag', async () => {
    const { prisma, error } = fakePrismaService();

    await new ErrorRepository(prisma).record(write());

    const call = error.upsert.mock.calls[0]?.[0];
    const { id: _id, ...createRest } = call?.create ?? {};
    expect(createRest).toStrictEqual(call?.update);
  });
});
