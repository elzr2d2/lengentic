/**
 * Scenarios for the session supervisor — `pnpm check:autopilot`.
 *
 * Two kinds of scenario, and the split is the point.
 *
 * The pure ones drive `progression.ts` with fixture verdicts, so every false-green shape is
 * exercised without needing the repository to be in that shape. The one that matters most is
 * scenario 3: eleven of eleven nodes DONE with a red gate is HOLD_PHASE. That is not a
 * hypothetical — `CLAUDE.md` ## Current state records a phase that sat at `pnpm gates:full`
 * exit 0 with two unbound Definition-of-Done checkboxes and was RED.
 *
 * The rest run the real supervisor loop against a real child process — `fixtures/fake-worker.mjs`
 * spawned exactly the way `claude -p` is. A crash, a rotation and a repair-exhaustion are all
 * about what happens ACROSS a process boundary, and a stub inside this process would test the
 * one thing that never breaks. The scenarios prove a second process ran by reading the launch
 * log the fixture appends to, and comparing pids.
 *
 * Deliberately outside `pnpm gates`, for the same reason `check:flow` and `check:lanes` are:
 * this reads `.claude/` and `.artifacts/`, and the product gate must keep working with the
 * engineering harness deleted.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FlowAction } from '../flow.ts';
import {
  green,
  phaseVerdict,
  red,
  unknown,
  waveVerdict,
  PHASE_SOURCES,
  type Sources,
} from './progression.ts';
import {
  failuresBlockingGate,
  gateScope,
  initialState,
  loadOrInit,
  readJournal,
  readState,
  repairKey,
  requestStop,
  StaleStateError,
  unresolvedFailures,
  writeState,
  type BlockingFailure,
} from './state.ts';
import { acquireLease, listLeases, reapExpired, releaseLease, renewLease } from './lease.ts';
import { buildBrief } from './bootstrap.ts';
import {
  describeRepairPolicy,
  resolveRepairPolicy,
  standingPolicy,
  STANDING_AUTHORITY,
  STANDING_REPAIR_BOUND,
} from './repair-policy.ts';
import {
  claudeLaunch,
  isRotationSubtype,
  newSessionId,
  newWorkerId,
  parseResultSubtype,
  readReport,
  resolveLaunch,
  resolvePermissionPosture,
  runWorker,
  shellCommandLine,
  DEFAULT_PERMISSION_MODE,
  SUPERVISED_PERMISSION_MODES,
  type WorkerSpec,
} from './worker.ts';
import {
  checkDodArtifact,
  checkEvidencePaths,
  DEFAULT_OPTIONS,
  renderEscalation,
  supervise,
  updateCheckpointSegment,
  type CommandResult,
  type SuperviseDeps,
  type SuperviseOptions,
} from './supervise.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SCHEMA = join(ROOT, '.claude/rules/worker-outcome.schema.json');
const FAKE_WORKER = join(HERE, 'fixtures/fake-worker.mjs');

// ── harness ───────────────────────────────────────────────────────────────────────────

interface Result {
  n: number;
  name: string;
  pass: boolean;
  detail: string;
}

const results: Result[] = [];
const cleanups: (() => void)[] = [];

async function scenario(n: number, name: string, fn: () => Promise<string | null> | string | null) {
  let detail: string | null;
  try {
    detail = await fn();
  } catch (e: unknown) {
    detail = `threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
  }
  results.push({ n, name, pass: detail === null, detail: detail ?? 'ok' });
}

/** A permission rule is `Tool(pattern)`. Anything else in those arrays is not a rule. */
const RULE_SHAPE = /^[A-Za-z]+\(.+\)$/;

function expect(cond: boolean, message: string): string | null {
  return cond ? null : message;
}

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lengentic-autopilot-'));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// ── a world the supervisor can act on ─────────────────────────────────────────────────

interface World {
  dir: string;
  stateDir: string;
  planPath: string;
  launches: () => {
    pid: number;
    node: string;
    task: string;
    workerId: string;
    sessionId: string;
    behaviour: string;
  }[];
  commands: string[];
  options: SuperviseOptions;
  deps: (actions: (i: number) => FlowAction, over?: Partial<SuperviseDeps>) => SuperviseDeps;
}

interface Plan {
  steps: Record<string, string[]>;
  evidenceDir?: string;
  dodPath?: string;
  dodBody?: string;
  commit?: string;
  trigger?: number;
  options?: string[];
}

function world(plan: Plan, over: Partial<SuperviseOptions> = {}): World {
  const dir = sandbox();
  const stateDir = join(dir, '.autopilot');
  const planPath = join(dir, 'plan.json');
  writeFileSync(
    planPath,
    JSON.stringify({ evidenceDir: '.artifacts/evidence/fake', ...plan }, null, 2),
    'utf8',
  );
  const commands: string[] = [];

  return {
    dir,
    stateDir,
    planPath,
    commands,
    launches: () => {
      const p = `${planPath}.launches.jsonl`;
      if (!existsSync(p)) return [];
      return readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as ReturnType<World['launches']>[number]);
    },
    options: {
      ...DEFAULT_OPTIONS,
      root: dir,
      stateDir,
      maxIterations: 8,
      repair: standingPolicy(),
      maxRotations: 3,
      workerTimeoutMs: 30_000,
      ...over,
    },
    deps: (actions, overDeps = {}) => {
      let i = 0;
      return {
        now: () => new Date(),
        deriveAction: () => {
          const a = actions(i);
          i += 1;
          return Promise.resolve(a);
        },
        runCommand: (command: string): CommandResult => {
          commands.push(command);
          return { command, code: 0, stdout: '', stderr: '', durationMs: 1 };
        },
        launchWorker: (spec) =>
          runWorker(spec, {
            schemaPath: SCHEMA,
            env: {
              ...process.env,
              AUTOPILOT_WORKER_CMD: process.execPath,
              AUTOPILOT_WORKER_ARGS: FAKE_WORKER,
              FAKE_WORKER_PLAN: planPath,
            },
          }),
        log: () => {},
        ...overDeps,
      };
    },
  };
}

function dispatchAction(node: string): FlowAction {
  return {
    action: 'DISPATCH',
    segment: '9',
    phase: 9,
    packets: [node],
    mode: 'sequential',
    steps: [`pnpm oracle packet ${node}`],
  };
}

const COMPLETE: FlowAction = { action: 'COMPLETE', reason: 'fixture world is delivered' };

// ── scenarios ─────────────────────────────────────────────────────────────────────────

async function run_(): Promise<number> {
  // ── the invariant ───────────────────────────────────────────────────────────────────

  const allGreen = (): Sources => {
    const out: Sources = {};
    for (const s of PHASE_SOURCES)
      out[s] = green(`fixture ${s}`, ['.artifacts/evidence/fixture.md']);
    return out;
  };

  await scenario(1, 'every mandatory source GREEN advances the phase', () => {
    const v = phaseVerdict(allGreen());
    return expect(
      v.verdict === 'ADVANCE_PHASE' && v.blockers.length === 0,
      `expected ADVANCE_PHASE; got ${v.verdict} ${JSON.stringify(v.blockers)}`,
    );
  });

  await scenario(2, 'C: 11/11 nodes with a RED gate is HOLD_PHASE, never ADVANCE_PHASE', () => {
    const s = allGreen();
    s.gates = red('pnpm gates:full exit 1', ['.artifacts/evidence/gates.log']);
    const v = phaseVerdict(s);
    return (
      expect(v.verdict === 'HOLD_PHASE', `expected HOLD_PHASE; got ${v.verdict}`) ??
      expect(
        v.blockers.some((b) => b.source === 'gates' && b.verdict === 'RED'),
        `the gate must be named as the blocker; got ${JSON.stringify(v.blockers)}`,
      )
    );
  });

  await scenario(3, 'a source nobody measured is UNKNOWN, and UNKNOWN counts as false', () => {
    const s = allGreen();
    delete s.definitionOfDone;
    const v1 = phaseVerdict(s);
    const s2 = allGreen();
    s2.definitionOfDone = unknown('validate-phase never ran');
    const v2 = phaseVerdict(s2);
    return (
      expect(v1.verdict === 'HOLD_PHASE', `absent source must hold; got ${v1.verdict}`) ??
      expect(
        v1.blockers[0]?.source === 'definitionOfDone',
        `the absent source must be named; got ${JSON.stringify(v1.blockers)}`,
      ) ??
      expect(v2.verdict === 'HOLD_PHASE', `explicit UNKNOWN must hold; got ${v2.verdict}`)
    );
  });

  await scenario(4, 'no single source may imply completion by itself', () => {
    for (const only of PHASE_SOURCES) {
      const s: Sources = {
        [only]: green('the one measured source', ['.artifacts/evidence/x.md']),
      };
      const v = phaseVerdict(s);
      if (v.verdict !== 'HOLD_PHASE') {
        return `${only} alone produced ${v.verdict}`;
      }
      if (v.blockers.length !== PHASE_SOURCES.length - 1) {
        return `${only} alone left ${String(v.blockers.length)} blockers, expected ${String(PHASE_SOURCES.length - 1)}`;
      }
    }
    return null;
  });

  await scenario(5, 'GREEN with no evidence path is not a gate record', () => {
    const s = allGreen();
    s.artifacts = { verdict: 'GREEN', derivedFrom: 'someone said so', evidence: [] };
    const v = phaseVerdict(s);
    return expect(
      v.verdict === 'HOLD_PHASE' && (v.blockers[0]?.why ?? '').includes('no evidence path'),
      `expected a hold naming the missing evidence; got ${JSON.stringify(v)}`,
    );
  });

  await scenario(
    6,
    'the wave gate uses the narrower source set and still refuses a RED gate',
    () => {
      const ok = waveVerdict({
        nodes: green('probes', ['e.md']),
        gates: green('pnpm gates exit 0', ['e.md']),
        validation: green('validator DONE', ['e.md']),
        failureEvidence: green('none unresolved', ['e.md']),
      });
      const bad = waveVerdict({
        nodes: green('probes', ['e.md']),
        gates: red('pnpm gates exit 1', ['e.md']),
        validation: green('validator DONE', ['e.md']),
        failureEvidence: green('none unresolved', ['e.md']),
      });
      return (
        expect(ok.verdict === 'RECORD_WAVE', `expected RECORD_WAVE; got ${ok.verdict}`) ??
        expect(bad.verdict === 'HOLD_WAVE', `expected HOLD_WAVE; got ${bad.verdict}`)
      );
    },
  );

  await scenario(7, 'a Definition-of-Done artifact is checked mechanically, not accepted', () => {
    const dir = sandbox();
    const write = (name: string, body: string): string => {
      const p = join(dir, name);
      writeFileSync(p, body, 'utf8');
      return p;
    };
    const cases: [string, string, boolean][] = [
      ['bound.md', '# DoD\n\n- [x] C1 bound to .artifacts/e.md\n- [x] C2 bound\n', true],
      ['unchecked.md', '- [x] one\n- [ ] two\n', false],
      ['notmet.md', '- [x] one — NOT MET pending evidence\n', false],
      ['deferred.md', '- [x] one (deferred to phase 4)\n', false],
      ['empty.md', '# DoD\n\nnothing here\n', false],
    ];
    for (const [name, body, want] of cases) {
      const got = checkDodArtifact(write(name, body));
      if (got.ok !== want)
        return `${name}: expected ok=${String(want)}, got ${JSON.stringify(got)}`;
    }
    return expect(
      !checkDodArtifact(join(dir, 'missing.md')).ok,
      'a missing artifact must not pass',
    );
  });

  await scenario(8, 'a gate record may not cite evidence that is missing or empty', () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'real.log'), 'EXIT=0\n', 'utf8');
    writeFileSync(join(dir, 'empty.log'), '', 'utf8');
    return (
      expect(checkEvidencePaths(dir, ['real.log']).ok, 'a real, non-empty path must pass') ??
      expect(!checkEvidencePaths(dir, []).ok, 'citing nothing must fail') ??
      expect(!checkEvidencePaths(dir, ['gone.log']).ok, 'a missing path must fail') ??
      expect(!checkEvidencePaths(dir, ['empty.log']).ok, 'an empty path must fail')
    );
  });

  // ── durable state ───────────────────────────────────────────────────────────────────

  await scenario(9, 'state writes are atomic and revision-checked', () => {
    const dir = sandbox();
    const s0 = loadOrInit(dir, new Date());
    const s1 = writeState(dir, { ...s0, segment: '9' }, new Date());
    if (s1.revision !== 1) return `expected revision 1, got ${String(s1.revision)}`;
    if (readState(dir)?.segment !== '9') return 'the write did not land';
    try {
      writeState(dir, { ...s0, segment: 'clobber' }, new Date());
      return 'a stale write was accepted — a newer state was silently clobbered';
    } catch (e: unknown) {
      return expect(
        e instanceof StaleStateError,
        `expected StaleStateError; got ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  await scenario(10, 'a corrupt state.json is a hard error, not a silent fresh start', () => {
    const dir = sandbox();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), '{not json', 'utf8');
    try {
      readState(dir);
      return 'a corrupt state file was silently accepted — the repair bounds would reset';
    } catch (e: unknown) {
      return expect(
        (e instanceof Error ? e.message : '').includes('not valid JSON'),
        'the error must say what is wrong with the file',
      );
    }
  });

  // ── leases ──────────────────────────────────────────────────────────────────────────

  await scenario(11, 'F: two workers cannot concurrently own the same node', () => {
    const dir = sandbox();
    const a = acquireLease(dir, 'p9.a', { workerId: 'w1', runId: 'r', pid: process.pid });
    const b = acquireLease(dir, 'p9.a', { workerId: 'w2', runId: 'r', pid: process.pid });
    return (
      expect(a.ok, 'the first acquire must succeed') ??
      expect(!b.ok, 'the second acquire must be refused') ??
      expect(
        !b.ok && b.held.workerId === 'w1',
        `the refusal must name the holder; got ${JSON.stringify(b)}`,
      ) ??
      expect(listLeases(dir).length === 1, 'exactly one lease file must exist')
    );
  });

  await scenario(
    12,
    'an expired lease held by a LIVE process is a slow worker, not a free node',
    () => {
      const dir = sandbox();
      const t0 = new Date('2026-08-21T00:00:00Z');
      acquireLease(
        dir,
        'p9.a',
        { workerId: 'w1', runId: 'r', pid: 4242 },
        { now: t0, ttlMs: 1000 },
      );
      const later = new Date(t0.getTime() + 60_000);
      const alive = acquireLease(
        dir,
        'p9.a',
        { workerId: 'w2', runId: 'r', pid: 1 },
        { now: later, isAlive: () => true },
      );
      const dead = acquireLease(
        dir,
        'p9.a',
        { workerId: 'w3', runId: 'r', pid: 1 },
        { now: later, isAlive: () => false },
      );
      return (
        expect(!alive.ok, 'an expired lease with a live pid must not be stolen') ??
        expect(dead.ok, 'an expired lease with a dead pid must be reclaimable') ??
        expect(
          dead.ok && dead.stole?.workerId === 'w1',
          'the reclaim must record whose lease it took',
        )
      );
    },
  );

  await scenario(13, 'a lease is released only by its own holder, and renewed only by it', () => {
    const dir = sandbox();
    acquireLease(dir, 'p9.a', { workerId: 'w1', runId: 'r', pid: process.pid });
    return (
      expect(!releaseLease(dir, 'p9.a', 'w2'), "releasing someone else's lease must fail") ??
      expect(renewLease(dir, 'p9.a', 'w2') === null, "renewing someone else's lease must fail") ??
      expect(renewLease(dir, 'p9.a', 'w1') !== null, 'renewing your own lease must work') ??
      expect(releaseLease(dir, 'p9.a', 'w1'), 'releasing your own lease must work') ??
      expect(listLeases(dir).length === 0, 'the lease file must be gone')
    );
  });

  await scenario(14, 'the reaper takes only leases whose holder is provably gone', () => {
    const dir = sandbox();
    const t0 = new Date('2026-08-21T00:00:00Z');
    acquireLease(dir, 'live', { workerId: 'w1', runId: 'r', pid: 1 }, { now: t0, ttlMs: 1 });
    acquireLease(dir, 'dead', { workerId: 'w2', runId: 'r', pid: 2 }, { now: t0, ttlMs: 1 });
    const later = new Date(t0.getTime() + 60_000);
    const reaped = reapExpired(dir, { now: later, isAlive: (pid) => pid === 1 });
    return (
      expect(
        reaped.length === 1 && reaped[0]?.node === 'dead',
        `reaped ${JSON.stringify(reaped)}`,
      ) ?? expect(listLeases(dir).length === 1, 'the live holder keeps its lease')
    );
  });

  // ── the worker contract, across a real process boundary ─────────────────────────────

  await scenario(15, 'a worker that exits 0 with no envelope is FAILED, never DONE', async () => {
    const w = world({ steps: { default: ['SILENT'] } });
    const spec = spec_(w, 'p9.a');
    const r = await runWorker(spec, {
      schemaPath: SCHEMA,
      env: fakeEnv(w),
    });
    return (
      expect(r.outcome === 'FAILED', `expected FAILED; got ${r.outcome}`) ??
      expect(r.exitCode === 0, `the process really did exit 0; got ${String(r.exitCode)}`) ??
      expect(
        r.derivedFrom.includes('without a valid outcome envelope'),
        `the reason must name the missing envelope; got ${r.derivedFrom}`,
      )
    );
  });

  await scenario(16, 'a worker that crashes is FAILED with its exit code recorded', async () => {
    const w = world({ steps: { default: ['CRASH'] } });
    const r = await runWorker(spec_(w, 'p9.a'), { schemaPath: SCHEMA, env: fakeEnv(w) });
    return (
      expect(r.outcome === 'FAILED', `expected FAILED; got ${r.outcome}`) ??
      expect(r.exitCode === 9, `expected exit 9; got ${String(r.exitCode)}`) ??
      expect(existsSync(r.stderrPath), 'stderr must be captured to a file')
    );
  });

  await scenario(
    17,
    'a valid envelope decides the outcome, and its schema is enforced',
    async () => {
      const w = world({ steps: { default: ['DONE'] } });
      const r = await runWorker(spec_(w, 'p9.a'), { schemaPath: SCHEMA, env: fakeEnv(w) });
      if (r.outcome !== 'DONE') return `expected DONE; got ${r.outcome} (${r.derivedFrom})`;

      // Same file, mutated to break the contract: BLOCKED without a trigger.
      writeFileSync(
        r.reportPath,
        JSON.stringify({
          schemaVersion: 1,
          workerId: 'w',
          task: 'dispatch',
          outcome: 'BLOCKED',
          summary: 'no trigger, no options',
        }),
        'utf8',
      );
      const bad = await readReport(r.reportPath, SCHEMA);
      return expect(
        !bad.ok && bad.errors.some((e) => e.includes('trigger')),
        `a BLOCKED envelope with no trigger must be rejected; got ${JSON.stringify(bad.errors)}`,
      );
    },
  );

  await scenario(18, 'the CLI result subtype separates "out of room" from "failed"', () => {
    const stream = [
      '{"type":"system","subtype":"init"}',
      'not json at all',
      '{"type":"result","subtype":"error_max_turns"}',
    ].join('\n');
    return (
      expect(parseResultSubtype(stream) === 'error_max_turns', 'the last result event wins') ??
      expect(parseResultSubtype('nothing here') === null, 'no result event is null') ??
      expect(isRotationSubtype('error_max_turns'), 'max turns is a rotation') ??
      expect(!isRotationSubtype('success'), 'success is not a rotation')
    );
  });

  await scenario(
    19,
    'the real launcher builds a claude argv; the override replaces it wholesale',
    () => {
      const w = world({ steps: { default: ['DONE'] } });
      const spec = spec_(w, 'p9.a');
      const real = resolveLaunch(spec, {}, { model: 'opus' });
      const overridden = resolveLaunch(spec, {
        AUTOPILOT_WORKER_CMD: 'node',
        AUTOPILOT_WORKER_ARGS: 'fake.mjs',
      });
      return (
        expect(real.args.includes('--print'), 'a real worker is non-interactive') ??
        expect(
          real.args.includes('--session-id') && real.args.includes(spec.sessionId),
          'the supervisor names the session before it exists',
        ) ??
        expect(
          !real.args.includes(spec.prompt) && !overridden.args.includes(spec.prompt),
          'the brief must never reach a command line — it goes down stdin',
        ) ??
        expect(
          overridden.command === 'node' && overridden.args[0] === 'fake.mjs',
          `the override must replace the launcher; got ${JSON.stringify(overridden)}`,
        ) ??
        expect(
          overridden.env.AUTOPILOT_REPORT_PATH === spec.reportPath,
          'the override still gets the envelope path',
        )
      );
    },
  );

  // ── the loop, across real session boundaries ────────────────────────────────────────

  await scenario(
    20,
    'A: a worker that dies mid-node is replaced, and the node continues',
    async () => {
      const w = world({ steps: { 'dispatch:p9.a': ['CRASH', 'DONE'] } });
      const r = await supervise(
        w.options,
        w.deps((i) => (i < 2 ? dispatchAction('p9.a') : COMPLETE)),
        SCHEMA,
      );
      const launches = w.launches();
      const pids = new Set(launches.map((l) => l.pid));
      return (
        expect(r.status === 'COMPLETE', `expected COMPLETE; got ${r.status}`) ??
        expect(launches.length === 2, `expected 2 launches; got ${String(launches.length)}`) ??
        expect(
          pids.size === 2,
          `the replacement must be a different process; pids ${[...pids].join(',')}`,
        ) ??
        expect(
          launches.every((l) => l.node === 'p9.a'),
          'both launches must be on the same node',
        ) ??
        expect(r.escalation === null, 'a crashed worker must not reach a human')
      );
    },
  );

  await scenario(
    21,
    'D: a rotation continues the same node in a fresh session, unattended',
    async () => {
      const w = world({ steps: { 'dispatch:p9.a': ['ROTATE', 'DONE'] } });
      const r = await supervise(
        w.options,
        w.deps((i) => (i < 2 ? dispatchAction('p9.a') : COMPLETE)),
        SCHEMA,
      );
      const launches = w.launches();
      const journal = readJournal(w.stateDir);
      const rotated = launches[0];
      const resumed = launches[1];
      return (
        expect(r.status === 'COMPLETE', `expected COMPLETE; got ${r.status}`) ??
        expect(launches.length === 2, `expected 2 launches; got ${String(launches.length)}`) ??
        expect(
          rotated !== undefined && resumed !== undefined && rotated.pid !== resumed.pid,
          'the continuation must be a different process',
        ) ??
        expect(
          rotated !== undefined && resumed !== undefined && rotated.sessionId !== resumed.sessionId,
          'the continuation must be a different session',
        ) ??
        expect(
          rotated !== undefined && resumed !== undefined && rotated.node === resumed.node,
          'the continuation must be on the same node',
        ) ??
        expect(
          journal.some((j) => j.transition === 'RUNNING -> ROTATE'),
          'the rotation must be journalled as a durable transition',
        ) ??
        expect(r.escalation === null, 'no human involvement')
      );
    },
  );

  await scenario(22, 'B: a supervisor restart reconstructs the run from disk', async () => {
    const w = world({ steps: { 'dispatch:p9.a': ['DONE'] } }, { maxIterations: 1 });
    const first = await supervise(
      w.options,
      w.deps(() => dispatchAction('p9.a')),
      SCHEMA,
    );
    const runId = first.state.runId;
    const revAfterFirst = readState(w.stateDir)?.revision ?? -1;

    // A brand-new supervisor process would do exactly this: nothing in memory, everything
    // from `w.stateDir`.
    const second = await supervise(
      { ...w.options, maxIterations: 2 },
      w.deps((i) => (i < 1 ? dispatchAction('p9.a') : COMPLETE)),
      SCHEMA,
    );
    return (
      expect(first.status === 'ITERATION_LIMIT', `first run: got ${first.status}`) ??
      expect(second.status === 'COMPLETE', `second run: got ${second.status}`) ??
      expect(
        second.state.runId === runId,
        `the run identity must survive the restart; ${runId} -> ${second.state.runId}`,
      ) ??
      expect(
        second.state.revision > revAfterFirst,
        'the second supervisor must continue the same state, not replace it',
      ) ??
      expect(
        w.launches().length === 2,
        `both supervisors dispatched work; got ${String(w.launches().length)}`,
      )
    );
  });

  await scenario(
    23,
    'E: repair exhausted stops, escalates on trigger 5, and mutates nothing more',
    async () => {
      const w = world({ steps: { default: ['REPAIR_REQUIRED'] } }, { maxIterations: 10 });
      const r = await supervise(
        w.options,
        w.deps(() => dispatchAction('p9.a')),
        SCHEMA,
      );
      const after = w.launches().length;
      // A second run must refuse to move: the escalation is unresolved.
      const again = await supervise(
        w.options,
        w.deps(() => dispatchAction('p9.a')),
        SCHEMA,
      );
      return (
        expect(r.status === 'ESCALATED', `expected ESCALATED; got ${r.status}`) ??
        expect(
          r.escalation?.trigger === 5,
          `expected trigger 5; got ${String(r.escalation?.trigger)}`,
        ) ??
        expect(
          after === w.options.repair.bound + 1,
          `expected ${String(w.options.repair.bound + 1)} launches; got ${String(after)}`,
        ) ??
        expect(
          again.status === 'ESCALATED',
          `the second run must also stop; got ${again.status}`,
        ) ??
        expect(
          w.launches().length === after,
          `no further autonomous mutation; launches went ${String(after)} -> ${String(w.launches().length)}`,
        )
      );
    },
  );

  await scenario(
    24,
    'C: a RED gate never becomes a gate record, however many nodes are DONE',
    async () => {
      const w = world({ steps: { default: ['DONE'] } }, { maxIterations: 2 });
      const action: FlowAction = {
        action: 'PHASE_GATE',
        segment: '9',
        phase: 9,
        agents: ['reviewer'],
        steps: ['pnpm gates:full'],
      };
      const deps = w.deps(() => action, {
        runCommand: (command: string): CommandResult => {
          w.commands.push(command);
          return {
            command,
            code: command.includes('gates') ? 1 : 0,
            stdout: command.includes('gates') ? 'FAIL src/x.spec.ts\n' : '',
            stderr: '',
            durationMs: 1,
          };
        },
      });
      const r = await supervise(w.options, deps, SCHEMA);
      const gateWorkerRan = w.launches().some((l) => l.task === 'phase-gate');
      const recorded = w.commands.some((c) => c.startsWith('pnpm flow record'));
      const verdictFile = findFile(
        join(w.dir, '.artifacts/evidence/autopilot'),
        'phase-gate-verdict.md',
      );
      return (
        expect(
          !recorded,
          `a gate record was written against a RED gate: ${w.commands.join(' | ')}`,
        ) ??
        expect(!gateWorkerRan, 'no agent work should be spent on a gate whose command is RED') ??
        expect(r.status !== 'COMPLETE', `the run must not complete; got ${r.status}`) ??
        expect(verdictFile !== null, 'the held verdict must be written to evidence') ??
        expect(
          verdictFile !== null && readFileSync(verdictFile, 'utf8').includes('HOLD_PHASE'),
          'the verdict artifact must say HOLD_PHASE',
        )
      );
    },
  );

  await scenario(25, 'a GREEN gate records exactly once, through `pnpm flow record`', async () => {
    const w = world(
      {
        steps: { default: ['DONE'] },
        dodPath: '.artifacts/evidence/9/phase-gate/definition-of-done.md',
      },
      { maxIterations: 2 },
    );
    const action: FlowAction = {
      action: 'PHASE_GATE',
      segment: '9',
      phase: 9,
      steps: ['pnpm gates:full'],
    };
    let i = 0;
    const deps = w.deps(() => {
      i += 1;
      return i <= 1 ? action : COMPLETE;
    });
    const r = await supervise(w.options, deps, SCHEMA);
    const records = w.commands.filter((c) => c.startsWith('pnpm flow record'));
    return (
      expect(r.status === 'COMPLETE', `expected COMPLETE; got ${r.status}`) ??
      expect(
        records.length === 1,
        `expected exactly one record command; got ${JSON.stringify(records)}`,
      ) ??
      expect(
        (records[0] ?? '').includes('record phase --segment 9'),
        `the record must name the segment; got ${records[0] ?? ''}`,
      ) ??
      expect((records[0] ?? '').includes('--evidence'), 'the record must point at evidence paths')
    );
  });

  await scenario(
    26,
    'a phase gate whose DoD artifact leaves a checkbox unbound is held',
    async () => {
      const w = world(
        {
          steps: { default: ['DONE'] },
          dodPath: '.artifacts/evidence/9/phase-gate/definition-of-done.md',
          dodBody: '# DoD\n\n- [x] C1 bound\n- [ ] C2 nobody checked\n',
        },
        { maxIterations: 2 },
      );
      const action: FlowAction = { action: 'PHASE_GATE', segment: '9', phase: 9, steps: [] };
      const r = await supervise(
        w.options,
        w.deps(() => action),
        SCHEMA,
      );
      return (
        expect(
          !w.commands.some((c) => c.startsWith('pnpm flow record')),
          'an unbound checkbox must not be recorded as a passed gate',
        ) ?? expect(r.status !== 'COMPLETE', `the run must not complete; got ${r.status}`)
      );
    },
  );

  await scenario(
    27,
    'F: a node already leased by a live process is not dispatched twice',
    async () => {
      const w = world({ steps: { default: ['DONE'] } }, { maxIterations: 1 });
      acquireLease(w.stateDir, 'p9.a', {
        workerId: 'someone-else',
        runId: 'other-run',
        pid: process.pid,
      });
      const r = await supervise(
        w.options,
        w.deps(() => dispatchAction('p9.a')),
        SCHEMA,
      );
      const journal = readJournal(w.stateDir);
      return (
        expect(
          w.launches().length === 0,
          `no worker may launch on a leased node; got ${String(w.launches().length)}`,
        ) ??
        expect(
          journal.some((j) => j.transition.includes('skipped (leased)')),
          'the skip must be journalled, not silent',
        ) ??
        expect(r.status === 'ITERATION_LIMIT', `got ${r.status}`)
      );
    },
  );

  await scenario(
    28,
    'a BLOCKED envelope escalates with its trigger, options and evidence intact',
    async () => {
      const w = world({
        steps: { default: ['BLOCKED'] },
        trigger: 4,
        options: ['use the staging credentials', 'skip the provider test for this phase'],
      });
      const r = await supervise(
        w.options,
        w.deps(() => dispatchAction('p9.a')),
        SCHEMA,
      );
      return (
        expect(r.status === 'ESCALATED', `expected ESCALATED; got ${r.status}`) ??
        expect(
          r.escalation?.trigger === 4,
          `the worker's trigger must survive; got ${String(r.escalation?.trigger)}`,
        ) ??
        expect(
          (r.escalation?.options ?? []).length === 2,
          `the options must survive; got ${JSON.stringify(r.escalation?.options)}`,
        ) ??
        expect(
          (r.escalation?.evidence ?? []).length > 0,
          'an escalation without evidence is not actionable',
        ) ??
        expect(
          renderEscalation(r.escalation!).startsWith('AUTOPILOT_BLOCKED'),
          'the rendered escalation must be the documented shape',
        )
      );
    },
  );

  await scenario(
    29,
    'a stop request is honoured at the next safe point, and survives a crash',
    async () => {
      const w = world({ steps: { default: ['DONE'] } }, { maxIterations: 5 });
      let i = 0;
      const deps = w.deps(() => dispatchAction('p9.a'), {
        deriveAction: () => {
          i += 1;
          if (i === 2) requestStop(w.stateDir, 'scenario', new Date());
          return Promise.resolve(dispatchAction('p9.a'));
        },
      });
      const r = await supervise(w.options, deps, SCHEMA);
      return (
        expect(r.status === 'STOPPED', `expected STOPPED; got ${r.status}`) ??
        expect(
          w.launches().length === 2,
          `the in-flight worker finishes first; got ${String(w.launches().length)}`,
        ) ??
        expect(
          readJournal(w.stateDir).some((j) => j.transition === 'RUNNING -> STOPPED'),
          'the stop must be journalled',
        )
      );
    },
  );

  await scenario(
    30,
    'a loop deriving the same action forever is declared stuck, not left running',
    async () => {
      const w = world({ steps: { default: ['DONE'] } }, { maxIterations: 50, noProgressLimit: 3 });
      const r = await supervise(
        w.options,
        w.deps(() => dispatchAction('p9.a')),
        SCHEMA,
      );
      return (
        expect(r.status === 'ESCALATED', `expected ESCALATED; got ${r.status}`) ??
        expect(
          r.escalation?.reason.includes('stuck') === true,
          `the escalation must say the run is stuck; got ${r.escalation?.reason ?? ''}`,
        ) ??
        expect(r.iterations <= 5, `it must stop early; ran ${String(r.iterations)} iterations`)
      );
    },
  );

  await scenario(
    31,
    'ADVANCE_PHASE is deterministic bookkeeping — no worker is launched',
    async () => {
      const w = world({ steps: { default: ['DONE'] } }, { maxIterations: 2 });
      mkdirSync(join(w.dir, '.claude'), { recursive: true });
      writeFileSync(
        join(w.dir, '.claude/autopilot.local.md'),
        '---\nphase: 9\nwave: 3\nstep: recovering\ncharter: docs/decisions/0011.md\n---\n\n## Recovery log\n\nkeep me\n',
        'utf8',
      );
      let i = 0;
      const r = await supervise(
        w.options,
        w.deps(() => {
          i += 1;
          return i <= 1
            ? { action: 'ADVANCE_PHASE', from: '9', to: '10', phase: 10, steps: [] }
            : COMPLETE;
        }),
        SCHEMA,
      );
      const text = readFileSync(join(w.dir, '.claude/autopilot.local.md'), 'utf8');
      return (
        expect(r.status === 'COMPLETE', `got ${r.status}`) ??
        expect(w.launches().length === 0, 'advancing a phase costs no worker') ??
        expect(text.includes('phase: 10'), `the checkpoint must move; got:\n${text}`) ??
        expect(text.includes('step: framed'), 'a stale `recovering` step must be cleared') ??
        expect(text.includes('charter:'), 'unrelated frontmatter must survive') ??
        expect(text.includes('keep me'), 'the recovery log must survive')
      );
    },
  );

  await scenario(32, 'the checkpoint rewriter creates a checkpoint when there is none', () => {
    const dir = sandbox();
    updateCheckpointSegment(dir, '5a');
    const text = readFileSync(join(dir, '.claude/autopilot.local.md'), 'utf8');
    return expect(text.includes('phase: 5a'), `got:\n${text}`);
  });

  // ── the brief ───────────────────────────────────────────────────────────────────────

  await scenario(
    33,
    'a worker brief carries commands, not the plan, and always the contract',
    () => {
      const state = initialState(new Date('2026-08-21T00:00:00Z'), 'run-1');
      const brief = buildBrief({
        task: 'dispatch',
        node: 'p3.scaffold',
        segment: '3',
        action: dispatchAction('p3.scaffold'),
        reportPath: '/tmp/x/report.json',
        workerId: 'w1',
        attempt: 1,
        maxAttempts: 2,
        state,
        failures: [],
        handoffs: ['.artifacts/handoffs/2-p2.sdk-core-builder.json'],
        decisions: ['docs/decisions/0011-autopilot-run-charter.md'],
        steps: ['pnpm oracle packet p3.scaffold'],
      });
      return (
        expect(
          brief.includes('pnpm oracle packet p3.scaffold'),
          'the packet command must be there',
        ) ??
        expect(brief.includes('/tmp/x/report.json'), 'the envelope path must be there') ??
        expect(brief.includes('worker-outcome.schema.json'), 'the contract must be cited') ??
        expect(
          brief.includes('There is no human watching'),
          'the worker must be told nobody will answer a question',
        ) ??
        expect(
          brief.includes('"Shall I continue?" is not a trigger'),
          'the non-escalation list must be there',
        ) ??
        expect(
          !brief.includes('MINIMAL PLAYGROUND'),
          'the plan text must NOT be inlined — the packet command is',
        ) ??
        expect(brief.length < 8_000, `the brief must stay small; ${String(brief.length)} chars`)
      );
    },
  );

  await scenario(
    34,
    'a repair brief states the attempt bound and forbids re-running the same fix',
    () => {
      const state = initialState(new Date('2026-08-21T00:00:00Z'), 'run-1');
      const brief = buildBrief({
        task: 'repair',
        node: 'p2.stale-on-kill',
        segment: '2',
        action: { action: 'WAVE_GATE', segment: '2' },
        reportPath: '/tmp/r.json',
        workerId: 'w2',
        attempt: 2,
        maxAttempts: 2,
        state,
        failures: [
          {
            id: 'f1',
            kind: 'gate',
            segment: '2',
            node: null,
            detail: 'pnpm gates exit 1',
            evidence: ['.artifacts/evidence/autopilot/run-1/2-wave-gate-command.log'],
            at: '2026-08-21T00:00:00Z',
          },
        ],
        handoffs: [],
        decisions: [],
        steps: [],
      });
      return (
        expect(brief.includes('attempt 2 of 2'), 'the bound must be explicit') ??
        expect(
          brief.includes('materially different'),
          'an attempt is a strategy, not a retry — say so',
        ) ??
        expect(
          brief.includes('2-wave-gate-command.log'),
          'the unresolved failure evidence must be cited by path',
        )
      );
    },
  );

  // ── the live repository ─────────────────────────────────────────────────────────────

  await scenario(
    35,
    'the worker-outcome schema is wired and this repository declares the commands',
    () => {
      const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      return (
        expect(existsSync(SCHEMA), `missing ${SCHEMA}`) ??
        expect(existsSync(FAKE_WORKER), `missing ${FAKE_WORKER}`) ??
        expect(pkg.scripts?.autopilot !== undefined, '`pnpm autopilot` must be declared') ??
        expect(
          pkg.scripts?.['check:autopilot'] !== undefined,
          '`pnpm check:autopilot` must be declared',
        ) ??
        expect(
          pkg.scripts?.gates?.includes('check:autopilot') !== true,
          'check:autopilot reads .claude/ and must stay OUT of `pnpm gates`',
        ) ??
        expect(
          pkg.scripts?.flow !== undefined && pkg.scripts?.lanes !== undefined,
          'the manual workflow commands must still exist — the supervisor composes them',
        )
      );
    },
  );

  await scenario(
    40,
    'the nodes source is re-probed at gate time, not inherited from the action that asked',
    async () => {
      const w = world(
        {
          steps: { default: ['DONE'] },
          dodPath: '.artifacts/evidence/9/phase-gate/definition-of-done.md',
        },
        { maxIterations: 2 },
      );
      const action: FlowAction = { action: 'PHASE_GATE', segment: '9', phase: 9, steps: [] };
      // Everything green EXCEPT the probe read. A `nodes` row inherited from the action would
      // not notice; a measured one holds the gate.
      const deps = w.deps(() => action, {
        runCommand: (command: string): CommandResult => {
          w.commands.push(command);
          return {
            command,
            code: command.includes('oracle status') ? 1 : 0,
            stdout: '',
            stderr: 'graph.json is unreadable',
            durationMs: 1,
          };
        },
      });
      const r = await supervise(w.options, deps, SCHEMA);
      const verdictFile = findFile(
        join(w.dir, '.artifacts/evidence/autopilot'),
        'phase-gate-verdict.md',
      );
      return (
        expect(
          !w.commands.some((c) => c.startsWith('pnpm flow record')),
          `an unreadable probe must not be recorded as a passed gate: ${w.commands.join(' | ')}`,
        ) ??
        expect(verdictFile !== null, 'the held verdict must be written to evidence') ??
        expect(
          verdictFile !== null && /^\s*RED\s+nodes\s/m.test(readFileSync(verdictFile, 'utf8')),
          `the verdict must name \`nodes\` as the RED source; got:
${verdictFile === null ? '' : readFileSync(verdictFile, 'utf8')}`,
        ) ??
        expect(r.status !== 'COMPLETE', `the run must not complete; got ${r.status}`)
      );
    },
  );

  // ── safety: the permission posture fails closed ─────────────────────────────────────

  await scenario(
    41,
    'bypassPermissions is not the default, and the default is not permissive',
    () => {
      const w = world({ steps: { default: ['DONE'] } });
      const spec = spec_(w, 'p9.a');
      const posture = resolvePermissionPosture({});
      if ('error' in posture) {
        return `the empty environment must resolve, not error: ${posture.error}`;
      }
      const launch = claudeLaunch(spec, {
        permissionMode: posture.mode,
        permissionsFile: '/repo/.claude/autopilot-permissions.json',
      });
      const modeIndex = launch.args.indexOf('--permission-mode');
      return (
        expect(
          posture.mode === DEFAULT_PERMISSION_MODE &&
            DEFAULT_PERMISSION_MODE !== 'bypassPermissions',
          `the default posture must not be bypass; got ${posture.mode}`,
        ) ??
        expect(!posture.bypassed, 'the default posture must not be flagged as bypassed') ??
        expect(
          !launch.args.includes('bypassPermissions'),
          `bypassPermissions must not appear in a default argv; got ${launch.args.join(' ')}`,
        ) ??
        expect(
          launch.args[modeIndex + 1] === DEFAULT_PERMISSION_MODE,
          `--permission-mode must carry the resolved default; got ${String(launch.args[modeIndex + 1])}`,
        ) ??
        expect(
          launch.args.includes('--settings') &&
            launch.args.includes('/repo/.claude/autopilot-permissions.json'),
          `the deny floor must ride along on --settings; got ${launch.args.join(' ')}`,
        )
      );
    },
  );

  await scenario(
    42,
    'bypass is reachable only by spelling it exactly; anything else fails closed',
    () => {
      const optIn = resolvePermissionPosture({ AUTOPILOT_PERMISSION_MODE: 'bypassPermissions' });
      const typo = resolvePermissionPosture({ AUTOPILOT_PERMISSION_MODE: 'bypasspermissions' });
      const nonsense = resolvePermissionPosture({ AUTOPILOT_PERMISSION_MODE: 'yes' });
      const plan = resolvePermissionPosture({ AUTOPILOT_PERMISSION_MODE: 'plan' });
      const narrower = resolvePermissionPosture({ AUTOPILOT_PERMISSION_MODE: 'acceptEdits' });
      const empty = resolvePermissionPosture({ AUTOPILOT_PERMISSION_MODE: '' });
      return (
        expect(
          !('error' in optIn) && optIn.mode === 'bypassPermissions' && optIn.bypassed,
          `the exact opt-in must be honoured and flagged; got ${JSON.stringify(optIn)}`,
        ) ??
        expect('error' in typo, 'a case typo must NOT resolve to bypass') ??
        expect('error' in nonsense, 'an unrecognised value must fail closed, not pass through') ??
        expect(
          'error' in plan,
          'a mode a worker cannot act under is not a supervised posture — refuse it here',
        ) ??
        expect(
          !('error' in narrower) && !narrower.bypassed,
          'a narrower posture must be accepted and not flagged as bypassed',
        ) ??
        expect(
          !('error' in empty) && empty.mode === DEFAULT_PERMISSION_MODE,
          'an empty value is an unset value, and unset means the closed default',
        ) ??
        expect(
          !(SUPERVISED_PERMISSION_MODES as readonly string[]).includes('plan'),
          'the supervised mode list must not contain a mode that cannot act',
        )
      );
    },
  );

  await scenario(43, 'the permission floor denies every escalation class it claims to', () => {
    const file = join(ROOT, '.claude/autopilot-permissions.json');
    if (!existsSync(file)) return `missing ${file}`;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      permissions?: { deny?: string[]; allow?: string[] };
    };
    const deny = parsed.permissions?.deny ?? [];
    const allow = parsed.permissions?.allow ?? [];
    const covers = (prefix: string): boolean => deny.some((d) => d.startsWith(prefix));

    // One representative per CLAUDE.md escalation class. A class losing its last rule is what
    // this scenario exists to catch — not the exact wording of any single rule.
    const classes: [string, string][] = [
      ['credentials: secret files', 'Read(~/.ssh'],
      ['credentials: environment dump', 'Bash(env:'],
      ['credentials: auth tooling', 'Bash(gh auth:'],
      ['production: cloud CLI', 'Bash(aws:'],
      ['production: cluster', 'Bash(kubectl:'],
      ['production: remote shell', 'Bash(ssh:'],
      ['external cost: publish', 'Bash(npm publish:'],
      ['destructive: push', 'Bash(git push:'],
      ['destructive: history rewrite', 'Bash(git reset --hard:'],
      ['destructive: recursive delete', 'Bash(rm -rf:'],
      ['destructive: database reset', 'Bash(pnpm db:reset:'],
      ['self-modification: gate records', 'Write(./.artifacts/gates/'],
      ['self-modification: the floor itself', 'Write(./.claude/autopilot-permissions.json'],
      ['self-modification: forging a gate', 'Bash(pnpm flow record:'],
    ];
    const uncovered = classes.filter(([, prefix]) => !covers(prefix)).map(([name]) => name);
    if (uncovered.length > 0) return `no deny rule covers: ${uncovered.join('; ')}`;

    // Ordinary repository-local development must still run unattended, or the supervisor fails
    // closed onto its own gates.
    const ordinary = ['Bash(pnpm gates)', 'Bash(pnpm test:*)', 'Bash(git commit:*)'];
    const missing = ordinary.filter((a) => !allow.includes(a));
    if (missing.length > 0) return `ordinary development is not allowed: ${missing.join(', ')}`;

    // Every entry must be a rule. A `$comment` string inside these arrays would be parsed as
    // one by the CLI and quietly weaken the file.
    const malformed = [...deny, ...allow].filter((r) => !RULE_SHAPE.test(r));
    return expect(
      malformed.length === 0,
      `every entry must be a Tool(pattern) rule; got ${JSON.stringify(malformed)}`,
    );
  });

  // ── safety: the repair bound cannot widen by accident ────────────────────────────────

  await scenario(
    44,
    'the standing repair bound is 2 attempts, and an attempt IS a strategy',
    () => {
      const p = resolveRepairPolicy({ exists: () => true });
      if ('error' in p) return `the default must resolve; got ${p.error}`;
      return (
        expect(
          STANDING_REPAIR_BOUND === 2,
          `CLAUDE.md trigger 5 is two; got ${String(STANDING_REPAIR_BOUND)}`,
        ) ??
        expect(p.bound === 2, `the default bound must be 2; got ${String(p.bound)}`) ??
        expect(!p.overridden, 'the default must not read as an override') ??
        expect(p.charter === null, 'the default has no charter') ??
        expect(
          STANDING_AUTHORITY.includes('CLAUDE.md') && STANDING_AUTHORITY.includes('trigger 5'),
          `the standing authority must cite the rule; got ${STANDING_AUTHORITY}`,
        ) ??
        expect(
          describeRepairPolicy(p).includes('attempt'),
          'the description must name the unit being counted',
        ) ??
        expect(
          DEFAULT_OPTIONS.repair.bound === STANDING_REPAIR_BOUND,
          `the supervisor default must be the standing bound; got ${String(DEFAULT_OPTIONS.repair.bound)}`,
        )
      );
    },
  );

  await scenario(
    45,
    'widening the bound is refused unless it names an authority that exists',
    () => {
      const bare = resolveRepairPolicy({ bound: 3, exists: () => true });
      const ghost = resolveRepairPolicy({
        bound: 3,
        charter: 'docs/decisions/9999-does-not-exist.md',
        exists: () => false,
      });
      const authorised = resolveRepairPolicy({
        bound: 3,
        charter: 'docs/decisions/0011-autopilot-run-charter.md',
        exists: () => true,
      });
      const tighter = resolveRepairPolicy({ bound: 1, exists: () => true });
      const orphanCharter = resolveRepairPolicy({
        charter: 'docs/decisions/0011-autopilot-run-charter.md',
        exists: () => true,
      });
      const zero = resolveRepairPolicy({ bound: 0, exists: () => true });
      return (
        expect(
          'error' in bare && bare.error.includes('--charter'),
          `--max-repairs 3 alone must be refused, naming the fix; got ${JSON.stringify(bare)}`,
        ) ??
        expect(
          'error' in bare && bare.error.includes('An attempt IS a strategy'),
          'the refusal must say why raising the count is not a rename',
        ) ??
        expect('error' in ghost, 'an authority nobody can read is not an authority') ??
        expect(
          !('error' in authorised) &&
            authorised.bound === 3 &&
            authorised.overridden &&
            authorised.charter === 'docs/decisions/0011-autopilot-run-charter.md',
          `a charter-authorised widening must be accepted and recorded; got ${JSON.stringify(authorised)}`,
        ) ??
        expect(
          !('error' in authorised) && authorised.authority.includes('0011'),
          'the recorded authority must name the record, not just say "override"',
        ) ??
        expect(
          !('error' in tighter) && tighter.bound === 1 && tighter.overridden,
          'tightening needs no authority, and is still recorded as a change',
        ) ??
        expect('error' in orphanCharter, '--charter without --max-repairs changes nothing') ??
        expect('error' in zero, 'a bound of zero would escalate before trying anything')
      );
    },
  );

  await scenario(
    46,
    'a run records the bound and the posture it started under, before any worker',
    async () => {
      const w = world({ steps: { default: ['DONE'] } }, { maxIterations: 1 });
      const authorised = resolveRepairPolicy({
        bound: 3,
        charter: 'docs/decisions/0011-autopilot-run-charter.md',
        exists: () => true,
      });
      if ('error' in authorised) return `fixture policy failed: ${authorised.error}`;
      const r = await supervise(
        {
          ...w.options,
          repair: authorised,
          permission: { mode: 'bypassPermissions', bypassed: true, source: 'test' },
        },
        w.deps(() => dispatchAction('p9.a')),
        SCHEMA,
      );
      const onDisk = readState(w.stateDir);
      const journal = readJournal(w.stateDir);
      const start = journal.find((j) => j.transition === 'START -> RUNNING');
      return (
        expect(
          onDisk?.repairBound === 3 && (onDisk.repairAuthority ?? '').includes('0011'),
          `the widened bound and its authority must be on disk; got ${JSON.stringify({ bound: onDisk?.repairBound, authority: onDisk?.repairAuthority })}`,
        ) ??
        expect(
          onDisk?.permissionMode === 'bypassPermissions' && onDisk.permissionBypassed === true,
          'a bypassed run must be recorded as bypassed, not left to look ordinary',
        ) ??
        expect(start !== undefined, 'the run start must be journalled with both bounds') ??
        expect(
          (start?.detail ?? '').includes('repair bound') &&
            (start?.detail ?? '').includes('bypassPermissions'),
          `the journal line must carry both; got ${start?.detail ?? ''}`,
        ) ??
        expect(r.state.revision > 0, 'the record must be written before the loop returns')
      );
    },
  );

  await scenario(
    47,
    'the exhaustion escalation quotes the bound it actually ran under',
    async () => {
      const w = world({ steps: { default: ['REPAIR_REQUIRED'] } }, { maxIterations: 10 });
      const tight = resolveRepairPolicy({ bound: 1, exists: () => true });
      if ('error' in tight) return `fixture policy failed: ${tight.error}`;
      const r = await supervise(
        { ...w.options, repair: tight },
        w.deps(() => dispatchAction('p9.a')),
        SCHEMA,
      );
      return (
        expect(r.status === 'ESCALATED', `expected ESCALATED; got ${r.status}`) ??
        expect(
          w.launches().length === 2,
          `a bound of 1 must escalate after 2 launches; got ${String(w.launches().length)}`,
        ) ??
        expect(
          (r.escalation?.reason ?? '').includes('Bound: 1 attempt(s)'),
          `the escalation must quote the bound it ran under; got ${r.escalation?.reason ?? ''}`,
        ) ??
        expect((r.escalation?.reason ?? '').includes('CLAUDE.md'), 'and the authority that set it')
      );
    },
  );

  await scenario(
    48,
    'a gate that held once can still record: its own hold is not failure evidence against it',
    async () => {
      // The livelock this pins down, observed live on run d9c2177c segment 3: a held gate
      // records a `kind: 'gate'` failure, that record resolves only when the gate records
      // GREEN, and `failureEvidence` counted it — so attempt 2 was RED because attempt 1
      // held, forever, across restarts and `pnpm autopilot resume` alike.
      const w = world(
        {
          steps: { default: ['DONE'] },
          dodPath: '.artifacts/evidence/9/phase-gate/definition-of-done.md',
          dodBody: '# DoD\n\n- [x] C1 bound\n- [ ] C2 nobody checked\n',
        },
        { maxIterations: 5 },
      );
      const action: FlowAction = { action: 'PHASE_GATE', segment: '9', phase: 9, steps: [] };
      const r = await supervise(
        w.options,
        w.deps((i) => {
          if (i === 1) {
            // The repair landed: the next gate attempt's worker writes a fully bound artifact.
            const plan = JSON.parse(readFileSync(w.planPath, 'utf8')) as Plan;
            plan.dodBody = '# DoD\n\n- [x] C1 bound\n- [x] C2 now verified\n';
            writeFileSync(w.planPath, JSON.stringify(plan, null, 2), 'utf8');
          }
          return i <= 1 ? action : COMPLETE;
        }),
        SCHEMA,
      );
      const records = w.commands.filter((c) => c.startsWith('pnpm flow record'));
      const unresolved = unresolvedFailures(readState(w.stateDir) ?? initialState(new Date()));
      return (
        expect(r.status === 'COMPLETE', `expected COMPLETE; got ${r.status}`) ??
        expect(
          records.length === 1,
          `the repaired gate must record exactly once; got ${JSON.stringify(records)}`,
        ) ??
        expect(
          unresolved.length === 0,
          `recording must resolve the hold record; still open: ${JSON.stringify(unresolved)}`,
        )
      );
    },
  );

  await scenario(
    49,
    "excluding a gate's own holds weakens nothing else: every other failure still blocks",
    () => {
      const failure = (over: Partial<BlockingFailure>): BlockingFailure => ({
        id: 'f',
        kind: 'gate',
        segment: '9',
        node: null,
        detail: 'x',
        evidence: [],
        at: '2026-08-30T00:00:00Z',
        ...over,
      });
      const state = {
        ...initialState(new Date('2026-08-30T00:00:00Z'), 'run-x'),
        blockingFailures: [
          failure({ id: 'own-hold' }),
          failure({ id: 'other-segment', segment: '8' }),
          failure({ id: 'worker-red', kind: 'worker', node: 'p9.a' }),
          failure({ id: 'invariant-red', kind: 'invariant' }),
          failure({ id: 'no-progress', kind: 'no-progress' }),
          failure({ id: 'already-resolved', kind: 'worker', resolvedAt: '2026-08-30T01:00:00Z' }),
        ],
      };
      const blocking = failuresBlockingGate(state, '9').map((f) => f.id);
      return (
        expect(
          !blocking.includes('own-hold'),
          'the gate being re-derived must not be blocked by its own prior hold',
        ) ??
        expect(
          blocking.includes('other-segment'),
          "another segment's held gate is real failure evidence and must block",
        ) ??
        expect(
          ['worker-red', 'invariant-red', 'no-progress'].every((id) => blocking.includes(id)),
          `worker, invariant and no-progress failures must all still block; got ${JSON.stringify(blocking)}`,
        ) ??
        expect(!blocking.includes('already-resolved'), 'a resolved failure never blocks')
      );
    },
  );

  await scenario(
    39,
    'the one shelled command line quotes here, and refuses what quoting cannot contain',
    () => {
      const spaced = shellCommandLine({
        command: 'claude',
        args: ['--settings', 'C:/Program Files/repo/.claude/autopilot-permissions.json'],
        env: {},
      });
      // `&&` inside a double-quoted argument is inert on both cmd.exe and sh — quoting IS the
      // correct handling for it, and throwing would break legitimate arguments. What quoting
      // cannot contain is a quote character or an expansion, so those throw.
      const quoted = shellCommandLine({ command: 'claude', args: ['rm -rf / && echo'], env: {} });
      const threw = (arg: string): string => {
        try {
          shellCommandLine({ command: 'claude', args: ['--print', arg], env: {} });
          return '';
        } catch (e: unknown) {
          return e instanceof Error ? e.message : String(e);
        }
      };
      const cases = ['a"b', '%PATH%', '$(id)', 'a`id`b', `x${String.fromCharCode(10)}y`];
      const survived = cases.filter((c) => threw(c) === '');
      return (
        expect(
          spaced ===
            'claude "--settings" "C:/Program Files/repo/.claude/autopilot-permissions.json"',
          `a path with a space must be quoted, not refused; got ${spaced}`,
        ) ??
        expect(
          quoted === 'claude "rm -rf / && echo"',
          `an inert metacharacter must be quoted, not thrown; got ${quoted}`,
        ) ??
        expect(
          survived.length === 0,
          `these must throw and did not: ${JSON.stringify(survived)}`,
        ) ??
        expect(
          threw('a"b').includes('shell metacharacters'),
          'the refusal must say what it is refusing',
        )
      );
    },
  );

  await scenario(
    37,
    'a parallel wave runs concurrently, one lease and one worker per node',
    async () => {
      const w = world({ steps: { default: ['DONE'] } }, { maxIterations: 2, concurrency: 3 });
      const parallelAction: FlowAction = {
        action: 'DISPATCH',
        segment: '9',
        phase: 9,
        packets: ['p9.a', 'p9.b', 'p9.c'],
        mode: 'parallel',
        steps: [],
      };
      let i = 0;
      const r = await supervise(
        w.options,
        w.deps(() => {
          i += 1;
          return i <= 1 ? parallelAction : COMPLETE;
        }),
        SCHEMA,
      );
      const launches = w.launches();
      const nodes = launches.map((l) => l.node).sort();
      return (
        expect(r.status === 'COMPLETE', `got ${r.status}`) ??
        expect(
          nodes.join(',') === 'p9.a,p9.b,p9.c',
          `each node must get exactly one worker; got ${nodes.join(',')}`,
        ) ??
        expect(
          new Set(launches.map((l) => l.pid)).size === 3,
          'three concurrent workers means three processes',
        ) ??
        expect(listLeases(w.stateDir).length === 0, 'every lease must be released afterwards')
      );
    },
  );

  await scenario(
    38,
    'a worker that hangs is killed and classified, not waited on forever',
    async () => {
      const w = world(
        { steps: { default: ['HANG'] } },
        { maxIterations: 1, workerTimeoutMs: 2_000 },
      );
      const started = Date.now();
      const r = await supervise(
        w.options,
        w.deps(() => dispatchAction('p9.a')),
        SCHEMA,
      );
      const elapsed = Date.now() - started;
      const journal = readJournal(w.stateDir);
      return (
        expect(elapsed < 30_000, `the kill must be prompt; took ${String(elapsed)}ms`) ??
        expect(
          journal.some((j) => j.transition === 'RUNNING -> FAILED'),
          'a killed worker is FAILED, and that transition is journalled',
        ) ??
        expect(
          journal.some((j) => (j.detail ?? '').includes('without writing an outcome envelope')),
          `the reason must name the missing envelope; got ${JSON.stringify(journal.map((j) => j.detail))}`,
        ) ??
        expect(listLeases(w.stateDir).length === 0, 'the lease must be released even on a kill') ??
        expect(r.status === 'ITERATION_LIMIT', `got ${r.status}`)
      );
    },
  );

  await scenario(
    36,
    'the supervisor derives its next action from the live repository',
    async () => {
      const { nextAction } = await import('../flow.ts');
      const a = await nextAction();
      return expect(
        a.action !== 'ERROR',
        `the live tree must produce a non-ERROR action; got ${JSON.stringify(a)}`,
      );
    },
  );

  await scenario(
    50,
    "each gate in a segment gets its own repair bucket — a phase gate never inherits a wave gate's spent attempts",
    () => {
      const phase = repairKey('4', null, gateScope('phase', []));
      const waveA = repairKey('4', null, gateScope('wave', ['p4.read-model', 'p4.run-summary']));
      const waveB = repairKey('4', null, gateScope('wave', ['p4.sdk-drop-reporting']));

      // The live regression, twice over: `4::gate` held 5 attempts spread across four distinct
      // gate actions, and the fifth action escalated on trigger 5 having spent one of its own.
      return (
        expect(phase !== waveA, `the phase gate and a wave gate shared ${phase}`) ??
        expect(waveA !== waveB, `two wave gates over different packets shared ${waveA}`) ??
        expect(
          repairKey('4', null, gateScope('wave', ['p4.run-summary', 'p4.read-model'])) === waveA,
          'the same packets in a different order must be the same gate',
        ) ??
        expect(
          repairKey('4', 'p4.read-model') !== phase,
          'a node repair must not share the phase gate bucket',
        ) ??
        expect(
          repairKey('4', null) === '4::gate',
          'the un-scoped key is unchanged, so old state still reads',
        ) ??
        expect(
          repairKey('5', null, gateScope('phase', [])) !== phase,
          "one phase's gate must not charge another phase's",
        )
      );
    },
  );

  return report();
}

// ── helpers used by the process-boundary scenarios ────────────────────────────────────

function spec_(w: World, node: string): WorkerSpec {
  const workerId = newWorkerId('dispatch', node);
  return {
    workerId,
    sessionId: newSessionId(),
    task: 'dispatch',
    node,
    segment: '9',
    prompt: 'fixture brief',
    reportPath: join(w.stateDir, 'handoffs', `${workerId}.json`),
    sessionDir: join(w.stateDir, 'sessions', workerId),
    cwd: w.dir,
    timeoutMs: 30_000,
  };
}

function fakeEnv(w: World): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AUTOPILOT_WORKER_CMD: process.execPath,
    AUTOPILOT_WORKER_ARGS: FAKE_WORKER,
    FAKE_WORKER_PLAN: w.planPath,
  };
}

/** Depth-first search for a file whose name ends with `suffix`. */
function findFile(dir: string, suffix: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = join(dir, e);
    if (e.endsWith(suffix)) return full;
    const nested = findFile(full, suffix);
    if (nested !== null) return nested;
  }
  return null;
}

// ── reporting ─────────────────────────────────────────────────────────────────────────

function report(): number {
  const failed = results.filter((r) => !r.pass);
  console.log('\nautopilot supervisor scenarios\n');
  for (const r of results.sort((a, b) => a.n - b.n)) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${String(r.n).padStart(2)}  ${r.name}`);
    if (!r.pass) console.log(`              ${r.detail}`);
  }
  console.log(`\n  ${String(results.length - failed.length)}/${String(results.length)} passed\n`);
  for (const c of cleanups) {
    try {
      c();
    } catch {
      /* a temp directory a worker still has open is not a test failure */
    }
  }
  return failed.length === 0 ? 0 : 1;
}

function isDirectRun(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return resolve(invoked).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) {
  process.exit(await run_());
}

export { run_ as runAutopilotScenarios };
