import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import {
  RUNS_LIST_MAX_LIMIT,
  type RunDetailView,
  type RunListView,
  type RunSummaryView,
} from '@lengentic/shared/read';

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

type HostChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * A spawned fixture process plus everything it has said so far.
 *
 * The two accumulators are attached by `spawnHost` rather than by each test, so no failure
 * path can reach a diagnostic message with the child's own output missing. Both are read as
 * functions, not captured strings: a message built at rejection time must show what the child
 * had written by then, not what it had written when the wait started.
 */
interface SpawnedHost {
  readonly child: HostChild;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

/**
 * Every host this file has spawned and not yet reaped.
 *
 * Killing each child on the happy path is not enough, and the phase-gate Reviewer filed
 * exactly why: `waitForLine` can reject and an `expect` can throw, and every `child.kill()`
 * in this file sits *after* both. So on any failing path a fixture that was deliberately
 * written never to end is left running, with nothing in the file responsible for it.
 *
 * How bad that gets today is measured rather than assumed, and it is milder than it looks:
 * `abandoned-run.ts` awaits a promise that never resolves, but the SDK unrefs its only timer
 * (`platform/telemetry-sdk/src/scheduler.ts:33`, `keepProcessAlive` defaults false), so once
 * the flush is done the child's ref'd event loop is empty and node exits 0 by itself. Forcing
 * a throw between the spawn and the kill with this reaper removed left zero surviving fixture
 * processes (`.artifacts/evidence/2/phase-gate/repair-1/raw/S2-no-afterEach-orphan-RED.txt`,
 * plus the self-exit probe beside it).
 *
 * Which is the argument for the reaper, not against it: "no live child is left behind" is
 * currently true only as a consequence of one default in a package this file does not own,
 * and a fixture that later holds any ref'd handle — a server, an interval, a `keepProcessAlive`
 * client — turns a red test into a CI job that hangs to its 20-minute timeout and reads as
 * infrastructure flake. A tracked set reaped in `afterEach` makes it true here, and secures
 * what no per-test `finally` can: a child spawned before a throw is killed even when the throw
 * lands between the spawn and whatever was going to guard it.
 */
const liveHosts = new Set<HostChild>();

function spawnHost(fixture: string, port: number, workflowVersion: string): SpawnedHost {
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

  return { child, stdout: () => stdout, stderr: () => stderr };
}

/** SIGKILLs `child` if it is still running, and resolves once the OS has reported it gone. */
function killAndWait(child: HostChild): Promise<void> {
  // Already gone: `close` has fired and will not fire again, so awaiting it would hang.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    child.once('close', () => resolve());
    child.kill('SIGKILL');
  });
}

function onExit(child: HostChild): Promise<HostExit> {
  return new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

/** What the child's own exit says, for a failure message. Unknown until the OS reports it. */
function describeExit(child: HostChild): string {
  if (child.exitCode !== null) return `exited with code ${String(child.exitCode)}`;
  if (child.signalCode !== null) return `was killed by ${child.signalCode}`;

  return 'had not exited yet';
}

/**
 * Resolves with the first stdout line starting with `prefix`.
 *
 * Rejects on three things rather than one — the deadline, a spawn error, and the child's own
 * output ending — and every rejection carries the child's accumulated stderr.
 *
 * Both additions are the same finding twice. With `platform/telemetry-sdk/dist` absent, the
 * fixture dies on an unresolvable import inside a few hundred milliseconds; the shape this
 * replaces then sat for the full deadline and reported `timed out after 15000ms waiting for a
 * line starting "RUN-STARTED "` — 15,026ms spent to say nothing about
 * `Cannot find package '@lengentic/telemetry-sdk'`, which the child had already written to a
 * stderr this function never read
 * (`.artifacts/evidence/2/phase-gate/repair-1/raw/S1-cold-sdk-dist-RED.txt`). A wait that
 * hides the cause diagnoses the test instead of the fixture.
 *
 * The "child is gone" signal is readline's `close`, not the child process's. A host that
 * prints its line and dies in the same breath emits both, and readline drains every buffered
 * line before closing — so taking the process event directly would race a delivered line
 * against the exit that followed it and reject a wait that had in fact succeeded.
 */
function waitForLine(host: SpawnedHost, prefix: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: host.child.stdout });
    let settled = false;

    // `settle` reads `timer` and `timer`'s callback calls `failWith`, so one of the three has
    // to be named before it is defined. Both directions are safe here because every one of
    // these is only ever *invoked* from an event handler — a line, a stream close, a spawn
    // error, or the timeout itself — and the whole block below is initialised synchronously
    // before any of those can run.
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      outcome();
    };

    const failWith = (reason: string): void => {
      const stderr = host.stderr();
      settle(() => {
        reject(
          new Error(
            `${reason}; host ${describeExit(host.child)}; fixture stderr: ` +
              (stderr === '' ? '(empty)' : stderr),
          ),
        );
      });
    };

    const timer = setTimeout(() => {
      failWith(`timed out after ${String(timeoutMs)}ms waiting for a line starting "${prefix}"`);
    }, timeoutMs);

    rl.on('line', (line: string) => {
      if (!line.startsWith(prefix)) return;

      settle(() => {
        resolve(line);
      });
    });

    // Fires after readline has emitted every line the child managed to write. Reaching it
    // unsettled means the line never came and is not going to.
    rl.on('close', () => {
      failWith(`host stdout closed before a line starting "${prefix}" arrived`);
    });

    host.child.on('error', (error: unknown) => {
      failWith(
        `host process failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
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
   * Polls the live API's LIST endpoint until `controlRunId` is reported `STALE`, and returns
   * the subject and the control **as they appeared in that one response**.
   *
   * ## Why the list, and why a control run
   *
   * The obvious wait — poll until the test process computes `now - lastEventAt > threshold`
   * — is not decisive, and the wave-3 Validator proved it: the server derives a response's
   * `status` from its OWN, earlier, `now`, and the HTTP round trip sits between the two
   * readings. So that loop can accept a response whose status was computed *before* the real
   * crossing and then assert `COMPLETED` on it vacuously. Measured: with the RUNNING-only
   * guard removed from `runs/stale.ts`, the old wait caught the mutation 3/13 times, and on
   * a re-run at this commit 0/8. A probabilistic mutation probe is how a green that lies
   * gets written twice.
   *
   * This wait removes the test's clock from the argument entirely. `RunsService.list` reads
   * the clock **once per list request, for the whole page** — deliberately, so that "two runs
   * with identical `lastEventAt` land on opposite sides of the threshold within one response"
   * cannot happen. That property is a premise of everything below, so it is pinned where it
   * lives rather than assumed here: `src/runs/runs.service.spec.ts`, "derives every run in one
   * page from a single clock reading", drives the service with a clock that advances between
   * readings and goes red on a per-row inversion that leaves the rest of the suite green.
   * Both runs below are therefore derived from a single server `now`. The caller asserts:
   *
   *   control.status === 'STALE'                    =>  now - control.lastEventAt  > threshold
   *   subject.lastEventAt <= control.lastEventAt    =>  now - subject.lastEventAt >= the above
   *                                                 =>  now - subject.lastEventAt  > threshold
   *
   * Both premises are read off that same response, so the time half of the staleness
   * predicate holds for the subject **by construction**, with no timing margin and no
   * reference to `Date.now()` in this process. Whatever the subject then reports can only
   * come from the stored-status half of the predicate.
   */
  const waitForControlStaleInSameResponse = async (
    subjectRunId: string,
    controlRunId: string,
    timeoutMs: number,
  ): Promise<{ subject: RunSummaryView; control: RunSummaryView }> => {
    const deadline = Date.now() + timeoutMs;
    let last: RunListView | undefined;
    for (;;) {
      const response = await request(app.getHttpServer())
        .get('/v1/runs')
        .query({ limit: RUNS_LIST_MAX_LIMIT });
      if (response.status === 200) {
        last = response.body as RunListView;
        const subject = last.runs.find((run) => run.id === subjectRunId);
        const control = last.runs.find((run) => run.id === controlRunId);
        if (subject !== undefined && control !== undefined && control.status === 'STALE') {
          return { subject, control };
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for control run ${controlRunId} to report ` +
            `STALE alongside subject ${subjectRunId} in one GET /v1/runs response; last seen: ` +
            JSON.stringify(last),
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

  /**
   * No test in this file can leave a live child process behind — however it failed, and
   * whether or not it reached its own `kill`. Runs after a failing test as well as a passing
   * one, which is the whole point: the paths that skip a `kill` are exactly the failing ones.
   */
  afterEach(async () => {
    const hosts = [...liveHosts];
    liveHosts.clear();

    await Promise.all(hosts.map(killAndWait));
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('a real host process, killed with SIGKILL mid-run, leaves a Run that GET /v1/runs/:id derives as STALE — the stored row stays RUNNING', async () => {
    const host = spawnHost('abandoned-run.ts', port, 'stale-on-kill-abandoned');

    const line = await waitForLine(host, 'RUN-STARTED ', WAIT_FOR_LINE_TIMEOUT_MS);
    const runId = line.slice('RUN-STARTED '.length).trim();
    expect(runId, `expected a non-empty runId; fixture stderr: ${host.stderr()}`).not.toBe('');

    // The row exists and is RUNNING *before* anything is killed — this is what rules out
    // the SIGKILL race named in the work packet. If this fails, the run never landed and
    // killing the process below would prove nothing.
    const before = await prisma.client.run.findUnique({ where: { id: runId } });
    expect(before?.status, `fixture stderr: ${host.stderr()}`).toBe('RUNNING');

    // The real kill. `abandoned-run.ts` never calls run.complete() or shutdown() — SIGKILL
    // is the only way this process ever ends. (`afterEach` would kill it too; this stays
    // because the kill is the behaviour under test, not just cleanup.)
    host.child.kill('SIGKILL');
    const exit = await onExit(host.child);
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
    const host = spawnHost('completed-run.ts', port, 'stale-on-kill-completed');

    const exit = await onExit(host.child);
    // Exit 0 is the whole claim about this fixture: `completed-run.ts` reaches the end of
    // `main()` only by completing the run and awaiting `shutdown()`. There is deliberately no
    // companion `expect(stderr).toBe('')` — it pinned nothing (this fixture has no stderr
    // path at all; the `DELIVERY-INCOMPLETE` write that does exist lives in `abandoned-run.ts`
    // and exits 1, which the assertion above already catches) while standing ready to fail on
    // a node or tsx warning that says nothing about the run. stderr stays where it is useful:
    // in the failure message, and in `waitForLine`'s rejections.
    expect(exit.code, `stdout: ${host.stdout()}\nstderr: ${host.stderr()}`).toBe(0);

    const match = /RUN-COMPLETED (\S+)/.exec(host.stdout());
    expect(match, `stdout: ${host.stdout()}`).not.toBeNull();
    const runId = match![1]!;

    // The control: a REAL abandoned run, spawned only now — after the subject process has
    // already exited 0 above — so the server stamps its `lastEventAt` strictly later than
    // the subject's. It is killed immediately, so it can never advance again and is
    // guaranteed to cross the threshold.
    //
    // Why a second run rather than a longer wait: the control is what makes the crossing
    // OBSERVABLE in the server's own terms. `STALE` on the control is the server telling us,
    // from its own single clock read, that the threshold has been passed — a fact this test
    // process is otherwise not able to establish about the server without racing it. See
    // `waitForControlStaleInSameResponse`.
    const control = spawnHost('abandoned-run.ts', port, 'stale-on-kill-completed-control');

    const controlLine = await waitForLine(control, 'RUN-STARTED ', WAIT_FOR_LINE_TIMEOUT_MS);
    const controlRunId = controlLine.slice('RUN-STARTED '.length).trim();
    expect(
      controlRunId,
      `expected a non-empty control runId; fixture stderr: ${control.stderr()}`,
    ).not.toBe('');

    control.child.kill('SIGKILL');
    const controlExit = await onExit(control.child);
    expect(
      controlExit.code,
      `control host exit was not a forced termination: ${JSON.stringify(controlExit)}`,
    ).not.toBe(0);

    const { subject, control: controlView } = await waitForControlStaleInSameResponse(
      runId,
      controlRunId,
      WAIT_FOR_STALE_TIMEOUT_MS,
    );

    // Premise 1, read off the server's response: at that single `now`, the control had been
    // idle longer than `STALE_RUN_THRESHOLD_MS`.
    expect(controlView.status).toBe('STALE');

    // Premise 2, read off the SAME response: the subject's last event is no later than the
    // control's. `<=` rather than `<` on purpose — it is all the arithmetic needs (it makes
    // the subject's idle time at least the control's), and it cannot fail spuriously if both
    // stamps ever land in one millisecond.
    expect(Date.parse(subject.lastEventAt)).toBeLessThanOrEqual(
      Date.parse(controlView.lastEventAt),
    );

    // Therefore `now - subject.lastEventAt > STALE_RUN_THRESHOLD_MS` held server-side for
    // the subject too, in the very response being asserted on. The time half of the
    // staleness predicate is satisfied by construction, so this can only be COMPLETED
    // because the stored terminal status won — which is exactly the false positive that
    // would destroy trust in the Run Explorer, and exactly what the positive test above
    // needs to be able to fail.
    expect(subject.status).toBe('COMPLETED');
    expect(subject.status).not.toBe('STALE');
    expect(subject.id).toBe(runId);

    const row = await prisma.client.run.findUnique({ where: { id: runId } });
    expect(row?.status).toBe('COMPLETED');
  }, 40_000);
});
