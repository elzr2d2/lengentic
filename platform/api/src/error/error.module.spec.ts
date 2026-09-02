import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { ErrorModule } from './error.module';
import { ErrorRepository } from './error.repository';
import { ErrorService } from './error.service';
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

describe('ErrorModule', () => {
  it('resolves ErrorService and reaches the database through its repository', async () => {
    const upsert = vi.fn(() => Promise.resolve());
    const moduleRef = await Test.createTestingModule({
      imports: [fakePrismaModule({ error: { upsert } }), ErrorModule],
    }).compile();

    const service = moduleRef.get(ErrorService);

    await service.record({
      eventId: 'evt-1',
      schemaVersion: '2',
      type: 'error.recorded',
      entityId: 'err-1',
      runId: 'run-9',
      occurredAt: '2026-09-02T10:00:00.000Z',
      payload: { stepId: 'step-1', type: 'TimeoutError', message: 'timed out' },
    });

    expect(moduleRef.get(ErrorRepository)).toBeInstanceOf(ErrorRepository);
    expect(upsert).toHaveBeenCalledTimes(1);

    await moduleRef.close();
  });
});
