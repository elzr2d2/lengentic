import { describe, expect, it, vi } from 'vitest';
import { ToolCallRepository } from './tool-call.repository';
import type { ToolCallWrite } from './tool-call-record';
import type { PrismaService } from '../prisma/prisma.service';

interface ToolCallUpsertArgs {
  readonly where: { readonly id: string };
  readonly create: Record<string, unknown>;
  readonly update: Record<string, unknown>;
}

function fakePrismaService(): {
  prisma: PrismaService;
  toolCall: { upsert: ReturnType<typeof vi.fn<(args: ToolCallUpsertArgs) => Promise<void>>> };
} {
  const toolCall = {
    upsert: vi.fn<(args: ToolCallUpsertArgs) => Promise<void>>(() => Promise.resolve()),
  };
  const prisma = { client: { toolCall } } as unknown as PrismaService;
  return { prisma, toolCall };
}

function write(overrides: Partial<ToolCallWrite> = {}): ToolCallWrite {
  return {
    id: 'tc-1',
    runId: 'run-9',
    stepId: 'step-1',
    toolName: 'search',
    input: { query: 'weather' },
    output: { rows: 3 },
    inputTruncated: false,
    outputTruncated: false,
    inputBytes: 42,
    outputBytes: 100,
    startedAt: new Date('2026-09-02T10:00:00.000Z'),
    completedAt: new Date('2026-09-02T10:00:00.250Z'),
    durationMs: 250,
    success: true,
    error: null,
    ...overrides,
  };
}

describe('ToolCallRepository.record', () => {
  it('keys the write on the entity id', async () => {
    const { prisma, toolCall } = fakePrismaService();

    await new ToolCallRepository(prisma).record(write({ id: 'tc-42' }));

    expect(toolCall.upsert.mock.calls[0]?.[0].where).toStrictEqual({ id: 'tc-42' });
  });

  it('carries the truncation flags and byte counts through', async () => {
    const { prisma, toolCall } = fakePrismaService();

    await new ToolCallRepository(prisma).record(
      write({ inputTruncated: true, inputBytes: 32_768 }),
    );

    expect(toolCall.upsert.mock.calls[0]?.[0].create).toMatchObject({
      inputTruncated: true,
      inputBytes: 32_768,
    });
  });

  it('create and update carry the same full column bag', async () => {
    const { prisma, toolCall } = fakePrismaService();

    await new ToolCallRepository(prisma).record(write());

    const call = toolCall.upsert.mock.calls[0]?.[0];
    const { id: _id, ...createRest } = call?.create ?? {};
    expect(createRest).toStrictEqual(call?.update);
  });

  it('writes in one statement — replaying the same id converges without a prior read', async () => {
    const { prisma, toolCall } = fakePrismaService();
    const repository = new ToolCallRepository(prisma);

    await repository.record(write());
    await repository.record(write());

    expect(toolCall.upsert).toHaveBeenCalledTimes(2);
  });
});
