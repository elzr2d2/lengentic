import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DEFAULT_CONFIG } from '@lengentic/analysis-engine';
import { describe, expect, it, vi } from 'vitest';

import { AnalysisController } from './analysis.controller';
import { AnalysisModule } from './analysis.module';
import { AnalysisRepository } from './analysis.repository';
import { AnalysisService } from './analysis.service';
import { ANALYZER_CONFIG } from './analyzer-config.provider';
import { CLOCK, type Clock } from '../common/clock';
import { PrismaService } from '../prisma/prisma.service';
import { RecommendationsService } from '../recommendations/recommendations.service';
import { STALE_THRESHOLD_MS } from '../runs/stale-threshold.provider';

/**
 * Wiring only: can the container build this module's graph, and is every token its providers
 * inject actually bound.
 *
 * Worth its own file for the reason `recommendations.module.spec.ts:11-19` already records —
 * a missing provider, an unregistered controller or a token nobody bound leaves every unit
 * spec in the directory green (they all construct their subjects with `new`) and the
 * capability unreachable at runtime. That exact mutant class survived the Phase 4 wave-4 gate
 * once already.
 *
 * `AnalysisModule` has three tokens that are easy to leave dangling and impossible to see
 * from a `new` — `CLOCK`, `STALE_THRESHOLD_MS` and `ANALYZER_CONFIG` — plus one cross-module
 * seam, `RecommendationsService`, which arrives only because `RecommendationsModule` exports
 * it. All four are asserted below.
 *
 * `PrismaService` and `ConfigService` arrive the way they do in production — from `@Global`
 * modules, which is why `AnalysisModule` imports neither — rather than via `overrideProvider`,
 * which only replaces a provider already in the graph. The values behind them are doubles: the
 * real `PrismaService` opens a database connection in its constructor.
 */

const STALE_MS = 1_800_000;

function fakeGlobals(client: unknown): new () => object {
  @Global()
  @Module({
    providers: [
      { provide: PrismaService, useValue: { client } },
      {
        provide: ConfigService,
        useValue: {
          get: (key: string) => (key === 'STALE_RUN_THRESHOLD_MS' ? STALE_MS : undefined),
        },
      },
    ],
    exports: [PrismaService, ConfigService],
  })
  class FakeGlobalsModule {}

  return FakeGlobalsModule;
}

async function analysisGraph(client: unknown = { decision: {}, run: {}, recommendation: {} }) {
  return Test.createTestingModule({ imports: [fakeGlobals(client), AnalysisModule] }).compile();
}

describe('AnalysisModule', () => {
  it('registers the controller, so §22 POST route has somewhere to land', async () => {
    const moduleRef = await analysisGraph();

    expect(moduleRef.get(AnalysisController)).toBeInstanceOf(AnalysisController);
    expect(moduleRef.get(AnalysisService)).toBeInstanceOf(AnalysisService);
    expect(moduleRef.get(AnalysisRepository)).toBeInstanceOf(AnalysisRepository);

    await moduleRef.close();
  });

  it('reaches RecommendationsService through RecommendationsModule exports, not by reaching past them', async () => {
    const moduleRef = await analysisGraph();

    // The seam `RecommendationsModule` exports for exactly this caller. If that `exports`
    // entry were emptied, this resolution fails while every unit spec stays green.
    expect(moduleRef.get(RecommendationsService)).toBeInstanceOf(RecommendationsService);

    await moduleRef.close();
  });

  it('binds a CLOCK, so an analysis run has an instant rather than an unresolved token', async () => {
    const moduleRef = await analysisGraph();

    const before = Date.now();
    const now = moduleRef.get<Clock>(CLOCK).now();
    const after = Date.now();

    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(after);

    await moduleRef.close();
  });

  it('binds STALE_THRESHOLD_MS from configuration, not from a constant reintroduced here', async () => {
    const moduleRef = await analysisGraph();

    // The fake `ConfigService` is the only source of this number, so reading it back proves
    // the provider went through configuration (ADR 0005 decision 4) rather than hard-coding.
    expect(moduleRef.get<number>(STALE_THRESHOLD_MS)).toBe(STALE_MS);

    await moduleRef.close();
  });

  it('binds ANALYZER_CONFIG to §19 five shipped thresholds', async () => {
    const moduleRef = await analysisGraph();

    // Transcribed from MVP_PLAN_V3.md §19's gate table, not read off the provider. These are
    // the numbers every persisted `configSnapshot` records and every gate compares against;
    // a `minSampleCount` of 1 would turn G1 into a formality with the suite still green.
    expect(moduleRef.get(ANALYZER_CONFIG)).toStrictEqual({
      minSampleCount: 30,
      minDistinctContexts: 5,
      dominanceThreshold: 0.9,
      successThreshold: 0.9,
      coverageThreshold: 0.8,
    });
    expect(DEFAULT_CONFIG.minSampleCount).toBe(30);

    await moduleRef.close();
  });

  it('drives a run end to end through the container — the whole graph, not one provider at a time', async () => {
    // Nothing in the database: the point is that `AnalysisService.run()` can be resolved and
    // called with every one of its five constructor dependencies satisfied. A dangling token
    // throws here rather than on the first real request.
    const findMany = vi.fn(() => Promise.resolve([]));
    const moduleRef = await analysisGraph({
      decision: { findMany },
      run: { findMany },
      recommendation: {},
    });

    await expect(moduleRef.get(AnalysisService).run()).resolves.toStrictEqual({
      evaluatedGroups: [],
    });

    await moduleRef.close();
  });

  it('exports nothing — §22 "analysis must not run inline with ingestion" is a property of the graph', async () => {
    // A module with no exports is a module no ingest-path module can acquire an edge to.
    // Stated in `analysis.module.ts`'s own comment; asserted here so the statement is checked.
    const moduleRef = await analysisGraph();

    await expect(
      Test.createTestingModule({
        imports: [fakeGlobals({}), AnalysisModule],
        providers: [{ provide: 'PROBE', inject: [AnalysisService], useFactory: (s: unknown) => s }],
      }).compile(),
    ).rejects.toThrow();

    await moduleRef.close();
  });
});
