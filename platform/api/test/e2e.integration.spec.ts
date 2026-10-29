import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { HttpAdapterHost } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  RecommendationListViewSchema,
  RepeatedFailedActionListViewSchema,
  type AnalysisRunResponse,
} from '@lengentic/shared';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * `p7.e2e` — E2E 1–4: real Playground CLI → public SDK → HTTP ingestion → PostgreSQL →
 * `POST /v1/analysis/run` → the reads the Dashboard consumes.
 *
 * Nothing between the CLI and the database is mocked. The Playground runs as a CHILD
 * PROCESS, never an import: `platform/**` must not reach `playground/**`
 * (`pnpm check:boundaries`), and a spawned CLI is also the only way to exercise the
 * documented `pnpm playground:*` entry points as a user runs them.
 *
 * Each flow asserts a NONZERO persisted workload before it asserts silence — an empty
 * ingestion would otherwise "pass" every no-recommendation assertion — and scopes its
 * assertions to the run / workflow cohort it produced, so one flow cannot satisfy another's.
 *
 * Browser rendering of the Dashboard is out of this packet's `allowed_paths`; the reads
 * asserted here are the ones the Dashboard parses, not the rendered page.
 */

const POSTGRES_IMAGE = 'postgres:17.6-alpine';
const REPO_ROOT = path.resolve(__dirname, '../../..');
const DATABASE_DIR = path.resolve(__dirname, '../../database');
const SDK_DIR = path.resolve(__dirname, '../../telemetry-sdk');

const httpServer = (app: NestExpressApplication): Server => app.getHttpServer();

const CANDIDATE_WORKFLOW = 'demo-workflow';
const CONTROL_WORKFLOW = 'batch-iteration-workflow';

interface PlaygroundResult {
  readonly stdout: string;
  readonly exitCode: number;
}

describe('E2E: Playground → SDK → API → PostgreSQL → analysis', () => {
  let container: StartedPostgreSqlContainer;
  let app: NestExpressApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let endpoint: string;

  const playground = (script: string): Promise<PlaygroundResult> =>
    new Promise((resolve, reject) => {
      execFile(
        'pnpm',
        ['exec', 'tsx', script, '--seed=42'],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, PLAYGROUND_ENDPOINT: endpoint },
          shell: process.platform === 'win32',
          timeout: 120_000,
        },
        (error, stdout, stderr) => {
          if (error !== null && typeof error.code !== 'number') {
            reject(new Error(`${script} did not run: ${error.message}\n${stderr}`));
            return;
          }
          resolve({ stdout, exitCode: typeof error?.code === 'number' ? error.code : 0 });
        },
      );
    });

  const analyze = async (): Promise<AnalysisRunResponse> => {
    const response = await request(httpServer(app)).post('/v1/analysis/run').send({});
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as AnalysisRunResponse;
  };

  const listRuns = async (): Promise<{ runs: { id: string; workflowName?: string }[] }> => {
    const response = await request(httpServer(app)).get('/v1/runs');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as { runs: { id: string; workflowName?: string }[] };
  };

  beforeAll(async () => {
    // The CLIs import the SDK through its built entry; a cold checkout has no `dist/`.
    execFileSync('pnpm', ['--filter', '@lengentic/telemetry-sdk...', 'build'], {
      cwd: SDK_DIR,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });

    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    const connectionString = container.getConnectionUri();

    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: DATABASE_DIR,
      env: { ...process.env, DATABASE_URL: connectionString },
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });

    process.env.DATABASE_URL = connectionString;
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'fatal';

    const { AppModule } = await import('../src/app.module');
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    const { configureBodyParser } = await import('../src/common/configure-body-parser');
    configureBodyParser(app);
    app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost).httpAdapter));
    app.setGlobalPrefix('v1', { exclude: ['health'] });
    await app.listen(0, '127.0.0.1');

    const { port } = httpServer(app).address() as AddressInfo;
    endpoint = `http://127.0.0.1:${String(port)}`;

    prisma = app.get(PrismaService);
  }, 360_000);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  beforeEach(async () => {
    await prisma.client.$executeRawUnsafe(
      'TRUNCATE TABLE "Run", "Step", "IngestedEvent", "Decision", "ToolCall", "Recommendation" RESTART IDENTITY CASCADE',
    );
  });

  it('E2E 1: happy path persists a visible Run, then analysis stays SILENT', async () => {
    // Negative precondition: the database really is empty before the CLI runs.
    expect(await prisma.client.run.count()).toBe(0);

    const cli = await playground('playground/cli/happy-path.ts');
    expect(cli.exitCode, cli.stdout).toBe(0);

    // Nonzero persisted workload FIRST — silence over nothing proves nothing.
    expect(await prisma.client.ingestedEvent.count()).toBeGreaterThan(0);
    const { runs } = await listRuns();
    expect(runs).toHaveLength(1);
    const runId = runs[0]!.id;

    const detail = await request(httpServer(app)).get(`/v1/runs/${runId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(JSON.stringify(detail.body)).toContain(runId);
    expect(await prisma.client.step.count()).toBeGreaterThan(0);

    const body = await analyze();
    expect(body.repeatedFailedActions ?? []).toStrictEqual([]);
    expect(body.evaluatedGroups.filter((g) => g.verdict === 'CANDIDATE')).toStrictEqual([]);
    expect(await prisma.client.recommendation.count()).toBe(0);

    const listed = RecommendationListViewSchema.parse(
      (await request(httpServer(app)).get('/v1/recommendations')).body,
    );
    expect(listed.recommendations).toStrictEqual([]);
  });

  it('E2E 2: repeated failures yield exactly one persisted REPEATED_FAILED_ACTION', async () => {
    expect(await prisma.client.recommendation.count()).toBe(0);

    const cli = await playground('playground/scenarios/repeated-failure/main.ts');
    expect(cli.exitCode, cli.stdout).toBe(0);
    expect(await prisma.client.toolCall.count()).toBeGreaterThanOrEqual(3);

    const body = await analyze();
    expect(body.repeatedFailedActions).toHaveLength(1);
    expect(body.repeatedFailedActions![0]!.attemptCount).toBeGreaterThanOrEqual(3);

    const page = RepeatedFailedActionListViewSchema.parse(
      (await request(httpServer(app)).get('/v1/recommendations?category=REPEATED_FAILED_ACTION'))
        .body,
    );
    expect(page.recommendations).toHaveLength(1);
    const recommendation = page.recommendations[0]!;
    expect(recommendation.category).toBe('REPEATED_FAILED_ACTION');
    expect(recommendation.status).toBe('OPEN');
    // Present on the wire even when empty — never omitted.
    expect(recommendation.counterexamples).toBeDefined();
    expect(await prisma.client.recommendation.count()).toBe(1);
  });

  it('E2E 4: the batch-iteration cohort is SUPPRESSED on G2 and yields no recommendation', async () => {
    const cli = await playground('playground/scenarios/deterministic-decision/main.ts');
    expect(cli.exitCode, cli.stdout).toBe(0);

    // Nonzero persisted workload for THIS cohort before asserting silence about it.
    const controlRuns = await prisma.client.run.findMany({
      where: { workflowName: CONTROL_WORKFLOW },
      select: { id: true },
    });
    expect(controlRuns.length).toBeGreaterThan(0);
    const controlDecisions = await prisma.client.decision.count({
      where: { runId: { in: controlRuns.map((r) => r.id) } },
    });
    expect(controlDecisions).toBeGreaterThan(0);

    const body = await analyze();
    const group = body.evaluatedGroups.find((g) => g.groupKey.workflowName === CONTROL_WORKFLOW);
    expect(group, JSON.stringify(body.evaluatedGroups)).toBeDefined();
    expect(group!.verdict).toBe('SUPPRESSED');
    expect(group!.failedGates).toContain('G2_context_diversity');
    expect(group!.recommendationId).toBeNull();

    const forControl = (await prisma.client.recommendation.findMany()).filter((row) =>
      JSON.stringify(row).includes(CONTROL_WORKFLOW),
    );
    expect(forControl).toStrictEqual([]);
  });

  it('E2E 3: the demo-workflow cohort yields DETERMINISTIC_CANDIDATE with counterexamples', async () => {
    const cli = await playground('playground/scenarios/deterministic-decision/main.ts');
    expect(cli.exitCode, cli.stdout).toBe(0);

    const body = await analyze();
    const group = body.evaluatedGroups.find((g) => g.groupKey.workflowName === CANDIDATE_WORKFLOW);
    expect(group, JSON.stringify(body.evaluatedGroups)).toBeDefined();
    expect(group!.verdict).toBe('CANDIDATE');
    expect(group!.failedGates).toStrictEqual([]);
    expect(group!.recommendationId).not.toBeNull();

    const page = RecommendationListViewSchema.parse(
      (await request(httpServer(app)).get('/v1/recommendations')).body,
    );
    // Exactly one persisted candidate, and it belongs to the candidate cohort, not the control.
    expect(page.recommendations).toHaveLength(1);
    const recommendation = page.recommendations[0]!;
    expect(recommendation.category).toBe('DETERMINISTIC_CANDIDATE');
    expect(recommendation.groupKey.workflowName).toBe(CANDIDATE_WORKFLOW);
    expect(recommendation.id).toBe(group!.recommendationId);
    expect(recommendation.counterexamples.length).toBeGreaterThan(0);
    expect(recommendation.evidence.gates).toHaveLength(5);
  });
});
