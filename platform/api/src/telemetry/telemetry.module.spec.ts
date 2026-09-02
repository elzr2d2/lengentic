import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { TelemetryModule } from './telemetry.module';
import { TelemetryService } from './telemetry.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Wiring only — the failure this catches is invisible to `telemetry.service.spec.ts`, which
 * constructs `TelemetryService` with `new` and cannot see a missing `imports` entry.
 *
 * ADR 0014: `TelemetryService` now depends on `DecisionsService`/`ModelCallService`/
 * `ToolCallService`/`ErrorService`, each from a module `TelemetryModule` must import itself
 * (Nest does not resolve a provider across sibling modules just because both are registered
 * somewhere in `AppModule`'s graph). Forgetting one of the four import entries fails
 * `moduleRef.get(TelemetryService)` here, and nowhere else in this suite.
 */
function fakePrismaModule(client: unknown): new () => object {
  @Global()
  @Module({
    providers: [{ provide: PrismaService, useValue: { client } }],
    exports: [PrismaService],
  })
  class FakePrismaModule {}

  return FakePrismaModule;
}

describe('TelemetryModule', () => {
  it('resolves TelemetryService with all four entity-write dependencies satisfied', async () => {
    const client = {
      decision: { upsert: vi.fn(() => Promise.resolve()) },
      modelCall: { upsert: vi.fn(() => Promise.resolve()) },
      toolCall: { upsert: vi.fn(() => Promise.resolve()) },
      error: { upsert: vi.fn(() => Promise.resolve()) },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [fakePrismaModule(client), TelemetryModule],
    }).compile();

    expect(moduleRef.get(TelemetryService)).toBeInstanceOf(TelemetryService);

    await moduleRef.close();
  });
});
