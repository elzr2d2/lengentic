import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { ToolCallModule } from './tool-call.module';
import { ToolCallRepository } from './tool-call.repository';
import { ToolCallService } from './tool-call.service';
import { PrismaService } from '../prisma/prisma.service';

function fakePrismaModule(client: unknown): new () => object {
  @Global()
  @Module({
    providers: [{ provide: PrismaService, useValue: { client } }],
    exports: [PrismaService],
  })
  class FakePrismaModule {}

  return FakePrismaModule;
}

describe('ToolCallModule', () => {
  it('resolves ToolCallService and reaches the database through its repository', async () => {
    const upsert = vi.fn(() => Promise.resolve());
    const moduleRef = await Test.createTestingModule({
      imports: [fakePrismaModule({ toolCall: { upsert } }), ToolCallModule],
    }).compile();

    const service = moduleRef.get(ToolCallService);

    await service.record({
      eventId: 'evt-1',
      schemaVersion: '2',
      type: 'tool_call.recorded',
      entityId: 'tc-1',
      runId: 'run-9',
      occurredAt: '2026-09-02T10:00:00.000Z',
      payload: {
        stepId: 'step-1',
        toolName: 'search',
        inputTruncated: false,
        outputTruncated: false,
        inputBytes: 0,
        outputBytes: 0,
        startedAt: '2026-09-02T10:00:00.000Z',
        completedAt: '2026-09-02T10:00:00.250Z',
        durationMs: 250,
        success: true,
      },
    });

    expect(moduleRef.get(ToolCallRepository)).toBeInstanceOf(ToolCallRepository);
    expect(upsert).toHaveBeenCalledTimes(1);

    await moduleRef.close();
  });
});
