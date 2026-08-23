import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { HttpAdapterHost } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../../src/common/all-exceptions.filter';
import type { RunDetailView } from '@lengentic/shared/read';

/**
 * The Phase 2 DoD **prose header**, joined end to end — `MVP_PLAN_V3.md:1599-1601`:
 *
 *   "A standalone TypeScript script can start a Run with a `workflowVersion`, create nested
 *    Steps, complete the Run, send everything through the public SDK, `shutdown()`, and exit
 *    cleanly."
 *
 * ## Why this file exists
 *
 * Every clause of that sentence was covered somewhere except one, and the phase-gate Tester
 * measured what the gap cost. `<StepHandle>.startStep(...)` — the nested call, the receiver
 * being a step rather than the run — occurred **exactly once** in the whole repository:
 * `platform/telemetry-sdk/test/record-and-batch.spec.ts:116`, a vitest worker against a fake
 * transport, no process boundary, no HTTP, no database. Every standalone host fixture started
 * one flat step.
 *
 * So the mutation that destroys SDK nesting outright —
 *
 *     handles.ts:103   startStep: (child) => createStep(recorder, runId, null, child)
 *
 * every nested step emitted as a root — cost exactly one fake-transport unit assertion and
 * left the **entire API integration suite green at 40/40**
 * (`.artifacts/evidence/2/phase-gate-2/tester/README.md` §7, raw at `raw/NEST1-flatten-nesting.txt`).
 * The product was correct; nothing was watching it. This file is the alarm.
 *
 * ## The seams
 *
 * Two, and nothing reaches past either:
 *
 * 1. **A real OS process**, spawned separately, importing `@lengentic/telemetry-sdk` by
 *    package name through its published `exports` map — the same resolution an external
 *    consumer gets, and the one `pretest:integration` builds `dist/` for. Its exit code and
 *    its stdout are the only things read from it. `run-lifecycle.integration.spec.ts` posts
 *    JSON to the ingest endpoint with supertest, which proves the API's §12 tree-building but
 *    says nothing about whether the SDK ever emits a non-null `parentStepId`; and
 *    `record-and-batch.spec.ts` proves the SDK's handles in isolation but never leaves the
 *    worker. What only this file has is the join.
 * 2. **`GET /v1/runs/:id`** over real HTTP against a real listening `http.Server`, backed by a
 *    real Postgres. Never the repository, never a row read.
 *
 * ## Where the expected values come from
 *
 * Not from the response. The fixture prints the four `stepId`s the SDK handed **it** back —
 * which one is the root, which the child, which the grandchild — and the assertions below map
 * that naming onto the `parentStepId` the API stored. Reading the chain out of the response
 * and checking it against itself would agree with any implementation, including a flattened
 * one. The shape asserted (root -> child -> grandchild, plus a second child of the root) is
 * the DoD's own "nested Steps", transcribed by hand from the fixture's call structure.
 *
 * `workflowVersion` is passed in from here and read back, because the same DoD sentence names
 * it: "start a Run with a `workflowVersion`".
 *
 * ## Beware the green that lies
 *
 * A host that died before `shutdown()` drained would leave no run at all, and a loose
 * assertion could pass on a 404 or on an empty step list. So: the exit code is asserted to be
 * 0 *before* anything else, the fixture's own delivery counters are asserted to account for
 * all ten events, and every assertion below names an id the fixture printed — never "some
 * step", never "the list is non-empty".
 */

const POSTGRES_IMAGE = 'postgres:17.6-alpine';
const DATABASE_DIR = path.resolve(__dirname, '../../../database');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/** Generous: a cold `tsx` start plus the SDK's retry budget, still far below the file timeout. */
const HOST_TIMEOUT_MS = 30_000;

/**
 * `run.started` + 4 x `step.started` + 4 x `step.completed` + `run.completed`.
 *
 * Counted off `nested-run.ts`'s call structure by hand, not read back from anything. It is the
 * "send everything through the public SDK" half of the DoD sentence: a host that reached
 * `HOST-OK` having quietly delivered fewer would otherwise satisfy every assertion below that
 * happened to name a step which did arrive.
 */
const EXPECTED_EVENTS = 10;

type HostChild = ChildProcessByStdio<null, Readable, Readable>;

interface HostResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Every host spawned and not yet reaped, so no failing path can leave one running. */
const liveHosts = new Set<HostChild>();

/**
 * Runs a fixture to completion and returns everything it said.
 *
 * The whole child is awaited rather than watched for a line: unlike `stale-on-kill`'s hosts,
 * this one is *supposed* to end on its own, and "it exited 0" is a clause of the DoD sentence
 * rather than cleanup. A deadline SIGKILLs it so a hang reads as a failed assertion here
 * instead of as the suite's own 40s timeout.
 *
 * Both streams are accumulated from the moment of spawn, so a failure message can never be
 * missing the child's own account of what went wrong.
 */
function runHost(fixture: string, port: number, workflowVersion: string): Promise<HostResult> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(FIXTURES_DIR, fixture), String(port), workflowVersion],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  liveHosts.add(child);

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

  return new Promise<HostResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `${fixture} did not exit within ${String(HOST_TIMEOUT_MS)}ms; ` +
            `stdout so far: ${stdout === '' ? '(empty)' : stdout}; ` +
            `stderr so far: ${stderr === '' ? '(empty)' : stderr}`,
        ),
      );
    }, HOST_TIMEOUT_MS);

    child.on('error', (error: unknown) => {
      clearTimeout(timer);
      reject(
        new Error(
          `${fixture} failed to start: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * The `HOST-OK` line, as a field map.
 *
 * Parsed rather than pattern-matched as a whole so a missing field is a missing key — which
 * fails the assertion that reads it, naming the field — instead of a regex that quietly
 * matched something else.
 */
function parseHostLine(stdout: string): Record<string, string> {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('HOST-OK '));
  if (line === undefined) return {};

  const fields: Record<string, string> = {};
  for (const pair of line.slice('HOST-OK '.length).trim().split(/\s+/)) {
    const equals = pair.indexOf('=');
    if (equals > 0) fields[pair.slice(0, equals)] = pair.slice(equals + 1);
  }

  return fields;
}

/** `stepId -> parentStepId`, exactly as the API answered. */
function parentByStepId(detail: RunDetailView): Record<string, string | null> {
  return Object.fromEntries(detail.steps.map((step) => [step.id, step.parentStepId]));
}

describe('A standalone host creating nested Steps through the public SDK (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let app: NestExpressApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let port: number;

  beforeAll(async () => {
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
    // Nothing here is about staleness, and the run completes — so the shipped default is what
    // this file runs against rather than an override it would then have to justify.
    delete process.env.STALE_RUN_THRESHOLD_MS;

    const [
      { ConfigModule },
      { PrismaModule },
      { TelemetryModule },
      { RunsModule },
      { validateEnv },
    ] = await Promise.all([
      import('@nestjs/config'),
      import('../../src/prisma/prisma.module'),
      import('../../src/telemetry/telemetry.module'),
      import('../../src/runs/runs.module'),
      import('../../src/config/env.schema'),
    ]);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          ignoreEnvFile: true,
          validate: validateEnv,
        }),
        PrismaModule,
        TelemetryModule,
        RunsModule,
      ],
    }).compile();

    // Same assembly as `main.ts` minus `nestjs-pino`, plus `app.listen()` — the fixture is a
    // separate OS process and needs a real TCP port it can dial, which supertest's
    // ephemeral-per-request binding does not provide.
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    const { configureBodyParser } = await import('../../src/common/configure-body-parser');
    configureBodyParser(app);
    app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost).httpAdapter));
    app.setGlobalPrefix('v1', { exclude: ['health'] });
    await app.init();
    await app.listen(0, '127.0.0.1');

    const address: AddressInfo | string | null = app.getHttpServer().address();
    if (address === null || typeof address === 'string') {
      throw new Error('could not determine the port the live API bound to');
    }
    port = address.port;

    prisma = app.get(PrismaService);
  }, 180_000);

  afterEach(async () => {
    const hosts = [...liveHosts];
    liveHosts.clear();

    await Promise.all(
      hosts.map((child) => {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

        return new Promise<void>((resolve) => {
          child.once('close', () => resolve());
          child.kill('SIGKILL');
        });
      }),
    );
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('starts a Run with a workflowVersion, nests Steps three deep, completes, shuts down and exits 0 — and GET /v1/runs/:id reports the parent chain the script never named', async () => {
    const workflowVersion = 'nested-steps-3.1.4';

    const host = await runHost('nested-run.ts', port, workflowVersion);

    // "…and exit cleanly." Asserted first: everything below is about a run that only exists
    // because this process got all the way to the end of `main()`.
    expect(
      host.code,
      `host did not exit cleanly (signal ${String(host.signal)})\n` +
        `stdout: ${host.stdout === '' ? '(empty)' : host.stdout}\n` +
        `stderr: ${host.stderr === '' ? '(empty)' : host.stderr}`,
    ).toBe(0);

    const fields = parseHostLine(host.stdout);
    expect(fields, `host stdout: ${host.stdout === '' ? '(empty)' : host.stdout}`).toHaveProperty(
      'runId',
    );

    // "…send everything through the public SDK, `shutdown()`". Ten recorded, ten delivered,
    // none abandoned — so no assertion below can pass because a step simply never arrived.
    expect(fields['recorded']).toBe(String(EXPECTED_EVENTS));
    expect(fields['delivered']).toBe(String(EXPECTED_EVENTS));
    expect(fields['undeliverable']).toBe('0');

    const runId = fields['runId'];
    const root = fields['root'];
    const child = fields['child'];
    const grandchild = fields['grandchild'];
    const sibling = fields['sibling'];
    expect([runId, root, child, grandchild, sibling], `host stdout: ${host.stdout}`).not.toContain(
      undefined,
    );

    const response = await request(app.getHttpServer()).get(`/v1/runs/${String(runId)}`);
    expect(response.status, `body: ${JSON.stringify(response.body)}`).toBe(200);
    const detail = response.body as RunDetailView;

    // "…start a Run with a `workflowVersion` … complete the Run".
    expect(detail.id).toBe(runId);
    expect(detail.workflowVersion).toBe(workflowVersion);
    expect(detail.workflowName).toBe('nested-steps-host');
    expect(detail.status).toBe('COMPLETED');

    // "…create nested Steps." The parent of each step, keyed by the id the SDK gave the
    // fixture — so the chain being asserted is the one the *script* built by calling
    // `startStep` on a handle, not one read back out of the answer being checked.
    //
    // `toStrictEqual` on the whole map rather than four separate lookups: it also pins that
    // the run has these four steps and no others, so a flattening that added a fifth root or
    // dropped the grandchild is a diff rather than a silent pass.
    expect(parentByStepId(detail)).toStrictEqual({
      [String(root)]: null,
      [String(child)]: root,
      [String(grandchild)]: child,
      [String(sibling)]: root,
    });

    // The stored rows, as the second observable interface. The API derives `status` at read
    // time (ADR 0005 decision 4) but `parentStepId` is stored, so a response that agreed with
    // the fixture while the database disagreed would be a real defect this assertion is the
    // only place to see.
    const rows = await prisma.client.step.findMany({
      where: { runId: String(runId) },
      select: { id: true, parentStepId: true, name: true, status: true },
      orderBy: { id: 'asc' },
    });
    expect(Object.fromEntries(rows.map((row) => [row.id, row.parentStepId]))).toStrictEqual({
      [String(root)]: null,
      [String(child)]: root,
      [String(grandchild)]: child,
      [String(sibling)]: root,
    });

    // The paired negative for the chain above. `sibling` completed FAILED and the others
    // COMPLETED, so "every step reports the same thing" cannot satisfy this file — and the
    // names pin which id is which independently of the parent map.
    expect(Object.fromEntries(rows.map((row) => [row.name, row.status]))).toStrictEqual({
      'root-step': 'COMPLETED',
      'child-step': 'COMPLETED',
      'grandchild-step': 'COMPLETED',
      'sibling-step': 'FAILED',
    });
  }, 60_000);
});
