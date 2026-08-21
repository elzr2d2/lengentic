import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
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
 * `p2.stale-on-kill` — the eleventh Phase 2 node, added after the wave 2 Reviewer filed C1
 * on MVP_PLAN_V3.md:1599: "Killing the script mid-run leaves a Run that derives as STALE"
 * was UNBOUND. Two things already existed and neither joined the other:
 *
 * - `platform/telemetry-sdk/test/process-exit.spec.ts` spawns a real host process and
 *   proves it exits 0 with the API down — no Run, no STALE derivation, nothing killed.
 * - `platform/api/test/run-lifecycle.integration.spec.ts`'s STALE `describe` block derives
 *   STALE from a *stored row* written directly through the ingestion HTTP boundary, under a
 *   settable `Clock` test double — never a real abandoned process.
 *
 * This file is the join neither one is: a REAL separately-spawned host process, going
 * through the public SDK exactly as the Phase 2 DoD's required flow names it
 * (`Standalone TypeScript client → Telemetry SDK → LenGentic API → PostgreSQL`), killed with
 * SIGKILL mid-run, with STALE read back off the LIVE API over a real HTTP request to a real
 * listening `http.Server` — not a repository call, not a row read under a controlled clock.
 * `run-lifecycle.integration.spec.ts` already owns the row-level STALE arithmetic across the
 * boundary condition; repeating that here would discharge nothing new. What only this file
 * proves is that a process that is really gone leaves a Run the running system really calls
 * STALE.
 *
 * ## Why the API is actually listening
 *
 * `run-lifecycle.integration.spec.ts` never calls `app.listen()` — supertest binds an
 * ephemeral connection per request against the Nest-internal server. That is not enough
 * here: the spawned child process needs a real TCP port it can dial from outside this test's
 * process, so this file calls `app.listen(0, '127.0.0.1')` in `beforeAll` and hands the
 * resolved port to every fixture on `argv`.
 *
 * ## Why the clock is NOT overridden
 *
 * `run-lifecycle.integration.spec.ts` injects a settable `Clock` because its tests move time
 * by fabricated amounts. This file wants the opposite: a real abandoned process, on the real
 * system clock, so `STALE_RUN_THRESHOLD_MS` is set to a small real value (`STALE_TEST_MS`
 * below) instead of the shipped 30-minute default, and every assertion waits on real wall
 * clock time. `CLOCK` therefore keeps its default `SystemClock` binding from `RunsModule`.
 *
 * ## Beware the green that lies
 *
 * A SIGKILL race — killing the host before its `run.started` event was ever flushed — would
 * leave no row at all, and a loosely-written assertion could pass on a 404 or an empty list.
 * `abandoned-run.ts` calls `telemetry.flush()` and checks `stats().delivered` before it ever
 * prints the line this file waits on, and this file additionally reads the stored row
 * straight out of Postgres (`status === 'RUNNING'`) before killing anything, so the run
 * killed below is provably alive first. Every assertion below names the exact `runId` the
 * fixture printed — never "some run", never "the list is non-empty".
 *
 * The negative case (`completed-run.ts`, spec below) is the suite's own mutation check per
 * `test-at-seams`: a STALE derivation that fires for every sufficiently-idle run regardless
 * of stored status would fail it, proving the STALE assertion above can actually fail.
 */

const POSTGRES_IMAGE = 'postgres:17.6-alpine';
const DATABASE_DIR = path.resolve(__dirname, '../../../database');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/**
 * A real value, not the shipped 30-minute default — this file cannot wait 30 real minutes
 * for a `describe` block. `STALE_RUN_THRESHOLD_MS` is a plain positive-integer env var
 * (`config/env.schema.ts`), so overriding it is legitimate configuration, not a test double
 * standing in for the derivation itself: the arithmetic under test
 * (`now - lastEventAt > STALE_RUN_THRESHOLD_MS`, `runs/stale.ts`) runs unmodified against a
 * real clock reading.
 */
const STALE_TEST_MS = 400;

const WAIT_FOR_STALE_TIMEOUT_MS = 20_000;
const WAIT_FOR_LINE_TIMEOUT_MS = 15_000;

/**
 * Yields the event loop between polls. Deliberately NOT a duration: `docs/ENGINEERING_STANDARDS.md`
 * TEST-1 forbids an arbitrary sleep in a test, and every wait in this file lands on an
 * observable condition with a deadline. This only gives the API's I/O a turn to run.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface HostExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function spawnHost(
  fixture: string,
  port: number,
  workflowVersion: string,
): ChildProcessByStdio<null, Readable, Readable> {
  return spawn(
    process.execPath,
    ['--import', 'tsx', path.join(FIXTURES_DIR, fixture), String(port), workflowVersion],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function onExit(child: ChildProcessByStdio<null, Readable, Readable>): Promise<HostExit> {
  return new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

/** Resolves with the first stdout line starting with `prefix`. Rejects on timeout or error. */
function waitForLine(
  child: ChildProcessByStdio<null, Readable, Readable>,
  prefix: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      rl.close();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for a line starting "${prefix}"`));
    }, timeoutMs);
    rl.on('line', (line) => {
      if (line.startsWith(prefix)) {
        clearTimeout(timer);
        rl.close();
        resolve(line);
      }
    });
    child.on('error', (error: unknown) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

describe('A real host process killed mid-run leaves its Run reporting STALE on the live API (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let app: NestExpressApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let port: number;

  /**
   * Polls the live API — never the row — until the server's own `lastEventAt` for `runId`
   * is older than `STALE_TEST_MS`, i.e. until the staleness predicate's time condition is
   * satisfied server-side. Returns the view read at that moment, so the caller asserts on
   * a response that was produced while the run was genuinely past the threshold.
   */
  const waitForApiIdleBeyondThreshold = async (
    runId: string,
    timeoutMs: number,
  ): Promise<RunDetailView> => {
    const deadline = Date.now() + timeoutMs;
    let last: RunDetailView | undefined;
    for (;;) {
      const response = await request(app.getHttpServer()).get(`/v1/runs/${runId}`);
      if (response.status === 200) {
        last = response.body as RunDetailView;
        const idleMs = Date.now() - Date.parse(last.lastEventAt);
        if (idleMs > STALE_TEST_MS) return last;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for run ${runId} to be idle beyond ` +
            `${STALE_TEST_MS}ms as the live API reports it; last seen: ${JSON.stringify(last)}`,
        );
      }
      await yieldToEventLoop();
    }
  };

  /** Polls the live API — never the row — until `runId` reports `expectedStatus`. */
  const waitForApiStatus = async (
    runId: string,
    expectedStatus: string,
    timeoutMs: number,
  ): Promise<RunDetailView> => {
    const deadline = Date.now() + timeoutMs;
    let last: RunDetailView | undefined;
    for (;;) {
      const response = await request(app.getHttpServer()).get(`/v1/runs/${runId}`);
      if (response.status === 200) {
        last = response.body as RunDetailView;
        if (last.status === expectedStatus) return last;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for run ${runId} to report ${expectedStatus} ` +
            `over HTTP; last seen: ${JSON.stringify(last)}`,
        );
      }
      await yieldToEventLoop();
    }
  };

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
    // The one deliberate departure from the shipped default: real wall-clock time, so this
    // suite can observe a real abandoned process cross the threshold without waiting 30
    // real minutes. See the file-level comment "Why the clock is NOT overridden".
    process.env.STALE_RUN_THRESHOLD_MS = String(STALE_TEST_MS);

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

    // Same assembly as `run-lifecycle.integration.spec.ts` / `main.ts`, minus `nestjs-pino`
    // — nothing on the path under test (routing, validation, service, repository, filter)
    // differs. The one addition is `app.listen()` below: this file's whole point is a
    // process outside this one dialing a real port, which supertest's ephemeral-per-request
    // binding does not provide.
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

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('a real host process, killed with SIGKILL mid-run, leaves a Run that GET /v1/runs/:id derives as STALE — the stored row stays RUNNING', async () => {
    const child = spawnHost('abandoned-run.ts', port, 'stale-on-kill-abandoned');
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

    const line = await waitForLine(child, 'RUN-STARTED ', WAIT_FOR_LINE_TIMEOUT_MS);
    const runId = line.slice('RUN-STARTED '.length).trim();
    expect(runId, `expected a non-empty runId; fixture stderr: ${stderr}`).not.toBe('');

    // The row exists and is RUNNING *before* anything is killed — this is what rules out
    // the SIGKILL race named in the work packet. If this fails, the run never landed and
    // killing the process below would prove nothing.
    const before = await prisma.client.run.findUnique({ where: { id: runId } });
    expect(before?.status, `fixture stderr: ${stderr}`).toBe('RUNNING');

    // The real kill. `abandoned-run.ts` never calls run.complete() or shutdown() — SIGKILL
    // is the only way this process ever ends.
    child.kill('SIGKILL');
    const exit = await onExit(child);
    // A clean exit(0) here would mean the fixture returned from `main()` on its own —
    // which it structurally cannot, since it awaits a promise that never resolves. Any
    // close event this test observes is therefore the kill taking effect, not the script
    // finishing.
    expect(exit.code, `host exit was not a forced termination: ${JSON.stringify(exit)}`).not.toBe(
      0,
    );

    // The live API, over a real HTTP request to the real listening server — never the
    // repository, never a row read.
    const stale = await waitForApiStatus(runId, 'STALE', WAIT_FOR_STALE_TIMEOUT_MS);
    expect(stale.status).toBe('STALE');
    expect(stale.id).toBe(runId);

    // ADR 0005 decision 4: derived at read time, never written to a row. Same guarantee
    // `run-lifecycle.integration.spec.ts` proves at the row-fixture level; here it is
    // proved against the row a real killed process actually produced.
    const after = await prisma.client.run.findUnique({ where: { id: runId } });
    expect(after?.status).toBe('RUNNING');
  }, 40_000);

  it('a host process that completes normally and calls shutdown() is never reported STALE, even after the same threshold has passed — the negative fixture the STALE assertion above needs to be able to fail', async () => {
    const child = spawnHost('completed-run.ts', port, 'stale-on-kill-completed');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

    const exit = await onExit(child);
    expect(exit.code, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
    expect(stderr).toBe('');

    const match = /RUN-COMPLETED (\S+)/.exec(stdout);
    expect(match, `stdout: ${stdout}`).not.toBeNull();
    const runId = match![1]!;

    // Wait past the same real threshold the positive case relies on, so a derivation that
    // ignores stored status and reports STALE for any sufficiently-idle run — the false
    // positive that would destroy trust in the Run Explorer — is exactly what this
    // assertion catches.
    //
    // The wait lands on an observable condition, not a duration: it polls the live API
    // until the server's OWN `lastEventAt` is further in the past than the threshold the
    // server was configured with. That is strictly stronger than sleeping for
    // `STALE_TEST_MS`, which would only assume the test's wall clock and the server's
    // agree. When this returns, `now - lastEventAt > STALE_RUN_THRESHOLD_MS` holds on the
    // server side — the exact predicate `runs/stale.ts` evaluates — so a status of
    // COMPLETED below can only come from the stored terminal state winning.
    const view = await waitForApiIdleBeyondThreshold(runId, WAIT_FOR_STALE_TIMEOUT_MS);
    expect(view.status).toBe('COMPLETED');
    expect(view.status).not.toBe('STALE');

    const row = await prisma.client.run.findUnique({ where: { id: runId } });
    expect(row?.status).toBe('COMPLETED');
  }, 40_000);
});
