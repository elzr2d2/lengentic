import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { ModelCallModule } from './model-call.module';
import { ModelCallRepository } from './model-call.repository';
import { ModelCallService } from './model-call.service';
import { PrismaService } from '../prisma/prisma.service';

/** Wiring only — mirrors `decisions.module.spec.ts`'s own rationale. */
function fakePrismaModule(client: unknown): new () => object {
  @Global()
  @Module({
    providers: [{ provide: PrismaService, useValue: { client } }],
    exports: [PrismaService],
  })
  class FakePrismaModule {}

  return FakePrismaModule;
}

describe('ModelCallModule', () => {
  it('resolves ModelCallService and reaches the database through its repository', async () => {
    const upsert = vi.fn(() => Promise.resolve());
    const moduleRef = await Test.createTestingModule({
      imports: [fakePrismaModule({ modelCall: { upsert } }), ModelCallModule],
    }).compile();

    const service = moduleRef.get(ModelCallService);

    await service.record({
      eventId: 'evt-1',
      schemaVersion: '2',
      type: 'model_call.recorded',
      entityId: 'mc-1',
      runId: 'run-9',
      occurredAt: '2026-09-02T10:00:00.000Z',
      payload: {
        stepId: 'step-1',
        provider: 'anthropic',
        model: 'claude-opus-5',
        latencyMs: 812,
        status: 'ok',
      },
    });

    expect(moduleRef.get(ModelCallRepository)).toBeInstanceOf(ModelCallRepository);
    expect(upsert).toHaveBeenCalledTimes(1);

    await moduleRef.close();
  });
});
