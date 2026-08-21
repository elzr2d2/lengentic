/**
 * `pnpm autopilot` — the session supervisor.
 *
 * A thin orchestration layer over machinery that already exists. It adds exactly one thing:
 * Claude sessions become disposable. The supervisor derives the next action from the
 * repository, launches a worker to perform it, consumes that worker's structured outcome,
 * and launches the next one. A session may die, run out of context, or be killed at any
 * moment; the run continues, because nothing that matters lived in the conversation.
 *
 * What it does NOT do is decide. `pnpm flow next` decides what happens next, `pnpm lanes
 * decide` decides sequential-versus-parallel, `pnpm gates` decides whether the code is good,
 * and `scripts/autopilot/progression.ts` decides whether a phase may advance. The manual
 * workflow those commands support keeps working untouched — the supervisor composes them,
 * and `pnpm autopilot --dry-run` shows exactly which ones it would run.
 *
 * Commands:
 *
 *   pnpm autopilot                run until COMPLETE, an escalation, or a stop
 *   pnpm autopilot status         the derived truth right now, from disk
 *   pnpm autopilot resume --note  record a human decision and continue past an escalation
 *   pnpm autopilot stop           ask a running supervisor to stop at the next safe point
 *   pnpm autopilot doctor         can this machine run a supervised session at all
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTOPILOT_DIR,
  clearStop,
  loadOrInit,
  readJournal,
  readState,
  requestStop,
  stopRequested,
  unresolvedFailures,
  writeState,
} from './autopilot/state.ts';
import { listLeases, isProcessAlive } from './autopilot/lease.ts';
import {
  describeRepairPolicy,
  resolveRepairPolicy,
  STANDING_REPAIR_BOUND,
} from './autopilot/repair-policy.ts';
import {
  resolvePermissionPosture,
  SUPERVISED_PERMISSION_MODES,
  type ClaudeOptions,
  type PermissionPosture,
} from './autopilot/worker.ts';
import {
  DEFAULT_OPTIONS,
  defaultDeps,
  supervise,
  shellRunner,
  type SuperviseOptions,
} from './autopilot/supervise.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = join(ROOT, AUTOPILOT_DIR);
const SCHEMA = join(ROOT, '.claude/rules/worker-outcome.schema.json');
const PERMISSIONS = join(ROOT, '.claude/autopilot-permissions.json');

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function num(argv: string[], name: string, fallback: number): number {
  const raw = flag(argv, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} expects a number, got "${raw}"`);
  return n;
}

/**
 * A refusal to start, as opposed to a crash. Both are exit 1, but a refusal is a decision this
 * code made on purpose and its stack trace is noise — the message IS the whole answer.
 */
class AutopilotRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutopilotRefusal';
  }
}

/**
 * Both safety bounds are resolved here, and both fail closed: a widened repair bound without its
 * authority, and an unrecognised permission mode, each stop the run before a worker exists
 * rather than falling back to something permissive.
 */
function optionsFrom(argv: string[]): SuperviseOptions {
  const maxRepairs = flag(argv, 'max-repairs');
  const repair = resolveRepairPolicy({
    bound: maxRepairs === undefined ? undefined : Number(maxRepairs),
    charter: flag(argv, 'charter'),
    exists: (p) => existsSync(resolve(ROOT, p)),
  });
  if ('error' in repair) throw new AutopilotRefusal(repair.error);

  const permission = resolvePermissionPosture(process.env);
  if ('error' in permission) throw new AutopilotRefusal(permission.error);

  return {
    ...DEFAULT_OPTIONS,
    root: ROOT,
    stateDir: STATE_DIR,
    repair,
    permission,
    maxIterations: num(argv, 'max-iterations', DEFAULT_OPTIONS.maxIterations),
    maxRotations: num(argv, 'max-rotations', DEFAULT_OPTIONS.maxRotations),
    concurrency: num(argv, 'concurrency', DEFAULT_OPTIONS.concurrency),
    workerTimeoutMs:
      num(argv, 'worker-timeout-min', DEFAULT_OPTIONS.workerTimeoutMs / 60_000) * 60_000,
    dryRun: has(argv, 'dry-run'),
  };
}

/** The launcher options a real worker runs under: the resolved posture plus the deny floor. */
function claudeOptionsFor(permission: PermissionPosture): ClaudeOptions {
  return {
    permissionMode: permission.mode,
    // Passing the floor to a bypassed session would be theatre — bypass skips every check.
    // Omitting it there keeps the argv honest about what is actually enforcing anything.
    ...(permission.bypassed ? {} : { permissionsFile: PERMISSIONS }),
    ...(process.env.AUTOPILOT_MODEL === undefined ? {} : { model: process.env.AUTOPILOT_MODEL }),
  };
}

// ── status ────────────────────────────────────────────────────────────────────────────

async function status(): Promise<number> {
  const state = readState(STATE_DIR);
  const { nextAction, checkpointState } = await import('./flow.ts');
  const action = await nextAction();
  // REPAIR, BLOCKED and COMPLETE carry no segment — they are about the run, not a phase. The
  // checkpoint still knows where the run is, and printing "(none derived)" there reads as if
  // the supervisor had lost its place.
  const segment = action.segment ?? action.to ?? checkpointState().segment ?? state?.segment;

  const lines: string[] = [
    '',
    'LenGentic autopilot supervisor — derived from disk, not from memory',
    '',
  ];

  lines.push(`  Next action     ${action.action}${action.reason ? ` — ${action.reason}` : ''}`);
  lines.push(`  Segment/phase   ${segment ?? '(none derived)'}`);
  if (action.packets && action.packets.length > 0) {
    lines.push(`  Packets         ${action.packets.join(', ')} (${action.mode ?? 'sequential'})`);
  }

  if (state === null) {
    lines.push('', '  No supervisor state yet — `pnpm autopilot` starts a run from the above.', '');
    console.log(lines.join('\n'));
    return 0;
  }

  const running = Object.entries(state.nodes).filter(([, n]) => n.status === 'RUNNING');
  const repairing = Object.entries(state.nodes).filter(([, n]) => n.status === 'REPAIR');
  const unresolved = unresolvedFailures(state);
  const leases = listLeases(STATE_DIR);

  lines.push('');
  lines.push(
    `  Run             ${state.runId}  (started ${state.startedAt}, rev ${String(state.revision)})`,
  );
  lines.push(`  Last green      ${state.lastGreenCommit ?? '(none recorded this run)'}`);
  lines.push(
    `  Workers         ${running.length > 0 ? running.map(([id, n]) => `${id} (${n.lastWorkerId ?? '?'})`).join(', ') : 'none running'}`,
  );
  for (const [id, n] of repairing) {
    const spent = state.repairAttempts[`${state.segment ?? '-'}::${id}`] ?? 0;
    lines.push(
      `  Repair          ${id} — attempt ${String(spent)}, last outcome ${n.lastOutcome ?? '?'}`,
    );
  }
  const gateKey = `${state.segment ?? '-'}::gate`;
  if (state.repairAttempts[gateKey] !== undefined) {
    lines.push(`  Gate repair     attempt ${String(state.repairAttempts[gateKey])}`);
  }
  lines.push(
    `  Leases          ${leases.length === 0 ? 'none' : leases.map((l) => `${l.node} -> ${l.workerId}${isProcessAlive(l.pid) ? '' : ' (pid gone)'}`).join(', ')}`,
  );
  lines.push(`  Stop requested  ${stopRequested(STATE_DIR) ? 'yes' : 'no'}`);
  // Both safety bounds, from the run that is actually on disk — not from what this invocation
  // would use. A run widened or bypassed by someone else must not read as an ordinary one.
  lines.push(
    `  Repair bound    ${String(state.repairBound ?? STANDING_REPAIR_BOUND)} attempt(s) — ` +
      `${state.repairAuthority ?? 'not recorded (run predates the bound being written down)'}`,
  );
  lines.push(`  Permissions     ${state.permissionMode ?? '(not recorded)'}`);
  if (state.permissionBypassed === true) {
    lines.push(
      '  WARNING         this run used bypassPermissions — every check was skipped, including',
      '                  .claude/autopilot-permissions.json. The CLAUDE.md escalation classes',
      '                  were not enforceable.',
    );
  }

  if (unresolved.length > 0) {
    lines.push('', '  Unresolved failure evidence:');
    for (const f of unresolved) {
      lines.push(`    [${f.kind}] ${f.node ?? f.segment ?? '-'} — ${f.detail}`);
      for (const e of f.evidence) lines.push(`        ${e}`);
    }
  }

  if (state.escalation !== null && state.escalation.resolvedAt === undefined) {
    lines.push('', '  BLOCKED on a human decision:');
    lines.push(`    trigger ${String(state.escalation.trigger)} — ${state.escalation.reason}`);
    for (const o of state.escalation.options) lines.push(`    - ${o}`);
    lines.push('', '    `pnpm autopilot resume --note "<the decision>"` continues from here.');
  }

  const journal = readJournal(STATE_DIR).slice(-5);
  if (journal.length > 0) {
    lines.push('', '  Recent transitions:');
    for (const j of journal) {
      lines.push(
        `    ${j.at}  ${j.transition}${j.node ? ` [${j.node}]` : ''}${j.detail ? ` — ${j.detail}` : ''}`,
      );
    }
  }
  lines.push('');
  console.log(lines.join('\n'));
  return 0;
}

// ── doctor ────────────────────────────────────────────────────────────────────────────

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function doctor(): Promise<number> {
  const checks: Check[] = [];

  const bin = process.env.AUTOPILOT_CLAUDE_BIN ?? 'claude';
  // One string, not an argv array: `shell: true` with an args array concatenates without
  // escaping (Node DEP0190). See `shellCommandLine` in scripts/autopilot/worker.ts.
  const v = spawnSync(`${bin} --version`, {
    encoding: 'utf8',
    shell: true,
    timeout: 20_000,
  });
  checks.push({
    name: 'claude CLI',
    ok: v.status === 0,
    detail:
      v.status === 0 ? (v.stdout ?? '').trim() : `\`${bin} --version\` exited ${String(v.status)}`,
  });

  checks.push({
    name: 'worker outcome schema',
    ok: existsSync(SCHEMA),
    detail: SCHEMA,
  });

  const posture = resolvePermissionPosture(process.env);
  checks.push({
    name: 'permission posture',
    ok: !('error' in posture) && !posture.bypassed,
    detail:
      'error' in posture
        ? posture.error
        : posture.bypassed
          ? 'bypassPermissions — EVERY check is skipped, including the deny floor. Unset ' +
            'AUTOPILOT_PERMISSION_MODE to fail closed again.'
          : `${posture.mode} (${posture.source}); modes: ${SUPERVISED_PERMISSION_MODES.join(' | ')}`,
  });

  checks.push({
    name: 'permission floor',
    ok: existsSync(PERMISSIONS),
    detail: existsSync(PERMISSIONS)
      ? `${PERMISSIONS} — deny beats allow and beats the auto classifier`
      : `${PERMISSIONS} is missing; workers would run with no deterministic floor`,
  });

  const repair = resolveRepairPolicy({ exists: (x) => existsSync(resolve(ROOT, x)) });
  checks.push({
    name: 'repair bound',
    ok: !('error' in repair),
    detail: 'error' in repair ? repair.error : describeRepairPolicy(repair),
  });

  try {
    const { nextAction } = await import('./flow.ts');
    const a = await nextAction();
    checks.push({
      name: 'flow derives an action',
      ok: a.action !== 'ERROR',
      detail: `${a.action}${a.reason ? ` — ${a.reason}` : ''}`,
    });
  } catch (e: unknown) {
    checks.push({
      name: 'flow derives an action',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  try {
    const state = readState(STATE_DIR);
    checks.push({
      name: 'supervisor state',
      ok: true,
      detail:
        state === null
          ? 'none yet (a run will create it)'
          : `rev ${String(state.revision)}, run ${state.runId}`,
    });
  } catch (e: unknown) {
    checks.push({
      name: 'supervisor state',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  const stale = listLeases(STATE_DIR).filter((l) => !isProcessAlive(l.pid));
  checks.push({
    name: 'node leases',
    ok: stale.length === 0,
    detail:
      stale.length === 0
        ? `${String(listLeases(STATE_DIR).length)} held, all by live processes`
        : `${String(stale.length)} held by dead pids: ${stale.map((l) => l.node).join(', ')} — a run reaps these on its first iteration`,
  });

  const git = shellRunner('git status --porcelain', ROOT);
  const dirty = (git.stdout ?? '').split('\n').filter((l) => l.trim() !== '');
  checks.push({
    name: 'working tree',
    ok: true,
    detail:
      dirty.length === 0
        ? 'clean'
        : `${String(dirty.length)} uncommitted change(s) — a worker will commit on top of them`,
  });

  console.log('\nautopilot doctor\n');
  for (const c of checks) {
    console.log(`  ${c.ok ? 'OK  ' : 'FAIL'}  ${c.name.padEnd(24)} ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n  ${String(checks.length - failed.length)}/${String(checks.length)} ready\n`);
  return failed.length === 0 ? 0 : 1;
}

// ── main ──────────────────────────────────────────────────────────────────────────────

const USAGE = `usage: pnpm autopilot [command] [options]

  (no command)          run until COMPLETE, an escalation, or a stop request
  status                what the repository says is true right now
  resume --note "..."   record a human decision, clear the escalation, and continue
  stop [--reason "..."] ask a running supervisor to stop at its next safe point
  doctor                can this machine run a supervised session

options for a run:
  --dry-run                    derive and print the next action; launch nothing
  --max-iterations <n>         loop bound (default ${String(DEFAULT_OPTIONS.maxIterations)})
  --max-repairs <n>            repair attempts before trigger 5 (default ${String(STANDING_REPAIR_BOUND)}).
                               An attempt IS a materially different strategy — raising this
                               raises the escalation bar, so a value above ${String(STANDING_REPAIR_BOUND)} must
                               name its authority with --charter.
  --charter <path>             the decision record authorising a widened --max-repairs
  --max-rotations <n>          rotations on one node before one repair is spent (default ${String(DEFAULT_OPTIONS.maxRotations)})
  --concurrency <n>            workers when the lane decision says parallel (default ${String(DEFAULT_OPTIONS.concurrency)})
  --worker-timeout-min <n>     hard kill for one worker (default ${String(DEFAULT_OPTIONS.workerTimeoutMs / 60_000)})
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] !== undefined && !argv[0].startsWith('--') ? argv[0] : 'run';

  switch (cmd) {
    case 'status':
      process.exit(await status());
      break;

    case 'doctor':
      process.exit(await doctor());
      break;

    case 'stop': {
      requestStop(STATE_DIR, flag(argv, 'reason') ?? 'requested by hand', new Date());
      console.log(
        'stop requested — a running supervisor exits at its next safe point, after the current ' +
          'worker finishes and its state is flushed. `pnpm autopilot` clears the request.',
      );
      break;
    }

    case 'resume': {
      const note = flag(argv, 'note');
      const state = loadOrInit(STATE_DIR, new Date());
      if (state.escalation !== null && state.escalation.resolvedAt === undefined) {
        if (note === undefined) {
          console.error(
            'this run is BLOCKED on a decision. Supply it: `pnpm autopilot resume --note "<decision>"`.\n' +
              `trigger ${String(state.escalation.trigger)} — ${state.escalation.reason}`,
          );
          process.exit(1);
        }
        writeState(
          STATE_DIR,
          {
            ...state,
            escalation: {
              ...state.escalation,
              resolvedAt: new Date().toISOString(),
              resolution: note,
            },
          },
          new Date(),
        );
        console.log(`escalation resolved: ${note}`);
      }
      clearStop(STATE_DIR);
      const options = optionsFrom(argv);
      const result = await supervise(
        options,
        defaultDeps(ROOT, SCHEMA, claudeOptionsFor(options.permission)),
        SCHEMA,
      );
      console.log(`\nautopilot ${result.status} after ${String(result.iterations)} iteration(s)\n`);
      process.exit(result.status === 'ESCALATED' ? 2 : 0);
      break;
    }

    case 'run': {
      const options = optionsFrom(argv);
      const result = await supervise(
        options,
        defaultDeps(ROOT, SCHEMA, claudeOptionsFor(options.permission)),
        SCHEMA,
      );
      console.log(`\nautopilot ${result.status} after ${String(result.iterations)} iteration(s)\n`);
      // 2 is "a human is needed", distinct from 1 "the supervisor itself failed".
      process.exit(result.status === 'ESCALATED' ? 2 : 0);
      break;
    }

    default:
      console.error(USAGE);
      process.exit(1);
  }
}

function isDirectRun(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return resolve(invoked).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) {
  main().catch((e: unknown) => {
    if (e instanceof AutopilotRefusal) {
      console.error(`
autopilot refused to start:

${e.message}
`);
      process.exit(1);
    }
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  });
}

export const USAGE_TEXT = USAGE;
