/**
 * The worker contract.
 *
 * A supervised Claude session is a disposable process. It is handed one task, it does the
 * work, and before it exits it writes ONE machine-readable file — its outcome envelope,
 * validated against `.claude/rules/worker-outcome.schema.json`. That file is the only thing
 * orchestration reads. The prose the worker printed is for a human scrolling the log.
 *
 * The derivation rule is deliberately asymmetric:
 *
 *   valid report on disk        -> the outcome it states
 *   no report, exit code 0      -> FAILED
 *   no report, non-zero exit    -> FAILED
 *   killed for exceeding time   -> FAILED
 *
 * A worker can never become DONE by exiting quietly, and no amount of confident output moves
 * it there either. `CLAUDE.md` ## Verification: DONE is a claim about evidence, not about a
 * green exit code. Turning a FAILED worker into another attempt is the supervisor's job and is
 * bounded there; turning it into progress is nobody's.
 *
 * Launching is injectable. The default builds a real `claude -p` argv; `AUTOPILOT_WORKER_CMD`
 * replaces it with any executable, which is how the crash, rotation and repair-exhaustion
 * scenarios in `pnpm check:autopilot` exercise real process boundaries without spending a
 * single API call.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

export type Outcome = 'DONE' | 'REPAIR_REQUIRED' | 'BLOCKED' | 'ROTATE' | 'FAILED';

export type WorkerTask =
  'dispatch' | 'integrate' | 'repair' | 'wave-gate' | 'phase-gate' | 'reconcile';

export interface WorkerReport {
  schemaVersion: number;
  workerId: string;
  sessionId?: string;
  task: WorkerTask;
  node?: string;
  outcome: Outcome;
  summary: string;
  commit?: string;
  handoff?: string;
  evidence?: string[];
  trigger?: number;
  options?: string[];
  detail?: string;
}

export interface WorkerSpec {
  workerId: string;
  /** Chosen by the supervisor so the session is addressable before it exists. */
  sessionId: string;
  task: WorkerTask;
  node: string | null;
  segment: string | null;
  prompt: string;
  /** Absolute path the worker must write its outcome envelope to. */
  reportPath: string;
  /** Directory for this worker's captured stdout/stderr. */
  sessionDir: string;
  cwd: string;
  timeoutMs: number;
  /** Set when this launch continues an interrupted session rather than starting clean. */
  resumeSessionId?: string;
}

export interface WorkerResult {
  workerId: string;
  sessionId: string;
  task: WorkerTask;
  node: string | null;
  outcome: Outcome;
  report: WorkerReport | null;
  /** Why the outcome is what it is, when no report supplied one. */
  derivedFrom: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  reportPath: string;
  /** The `subtype` of the CLI's final `result` event, when one was emitted. */
  resultSubtype: string | null;
}

export function newWorkerId(task: WorkerTask, node: string | null): string {
  return `${task}-${node ?? 'gate'}-${randomUUID().slice(0, 8)}`;
}

export function newSessionId(): string {
  return randomUUID();
}

// ── the outcome envelope ──────────────────────────────────────────────────────────────

export interface ReportVerdict {
  ok: boolean;
  report: WorkerReport | null;
  errors: string[];
}

/**
 * Read and validate an outcome envelope. Reuses the same subset validator the lane-handoff
 * hook uses, for the same reason it exists: `.claude/` must stay deletable and must never
 * become a runtime dependency, so no `ajv`.
 */
export async function readReport(reportPath: string, schemaPath: string): Promise<ReportVerdict> {
  if (!existsSync(reportPath)) {
    return { ok: false, report: null, errors: [`no outcome envelope at ${reportPath}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (e: unknown) {
    return {
      ok: false,
      report: null,
      errors: [`${reportPath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
  if (!existsSync(schemaPath)) {
    return { ok: false, report: null, errors: [`missing schema: ${schemaPath}`] };
  }
  const libPath = new URL('../../.claude/hooks/lib/validate-schema.mjs', import.meta.url).href;
  const lib = (await import(libPath)) as { validate: (v: unknown, s: object) => string[] };
  const errors = lib.validate(parsed, JSON.parse(readFileSync(schemaPath, 'utf8')) as object);
  if (errors.length > 0) return { ok: false, report: null, errors };
  return { ok: true, report: parsed as WorkerReport, errors: [] };
}

/**
 * The last `result` event of a `--output-format stream-json` run, when there is one. Its
 * `subtype` distinguishes a worker that finished from one the CLI itself stopped — which is
 * the difference between a failure and a rotation.
 */
export function parseResultSubtype(stdout: string): string | null {
  const lines = stdout.split('\n').filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const e = JSON.parse(lines[i] ?? '') as { type?: unknown; subtype?: unknown };
      if (e.type === 'result') return typeof e.subtype === 'string' ? e.subtype : 'result';
    } catch {
      /* a partial line at the tail of a killed process is normal */
    }
  }
  return null;
}

/** CLI subtypes that mean "the session ran out of room", not "the work failed". */
const ROTATION_SUBTYPES = new Set([
  'error_max_turns',
  'error_max_tokens',
  'error_max_budget',
  'error_context_limit',
]);

export function isRotationSubtype(subtype: string | null): boolean {
  return subtype !== null && ROTATION_SUBTYPES.has(subtype);
}

// ── launching ─────────────────────────────────────────────────────────────────────────

export interface LaunchCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface ClaudeOptions {
  model?: string | undefined;
  /** Resolved by `resolvePermissionPosture`. Never defaulted at the call site. */
  permissionMode?: string | undefined;
  /** Path to the deny/allow floor passed to `--settings`. */
  permissionsFile?: string | undefined;
  maxBudgetUsd?: string | undefined;
}

// ── permission posture ────────────────────────────────────────────────────────────────

/**
 * The default posture for an autonomous worker: **fail closed**.
 *
 * `auto` is the judgement layer — its shipped rules already allow ordinary local repository
 * operations and deny Production Deploy, Credential Exploration, Irreversible Local Destruction
 * and Data Exfiltration. But it is a classifier, not a gate: measured against a scratch
 * repository it permitted `git push --force`
 * (`.artifacts/evidence/autopilot/permission-posture.md`, probe 1). So the classifier is not
 * load-bearing on its own. `.claude/autopilot-permissions.json` is the deterministic floor
 * underneath it, and `deny` beats both `allow` and the classifier — measured, probe 3.
 *
 * `bypassPermissions` skips every check, including that floor. It is therefore not reachable by
 * default, by a typo, or by a flag: it needs `AUTOPILOT_PERMISSION_MODE=bypassPermissions`
 * spelled exactly, and the supervisor records and announces that it was used.
 */
// Typed as `string`, not as its literal, on purpose: the checks that assert this is not
// `bypassPermissions` must be real runtime checks that survive someone changing the value,
// not comparisons the compiler folds away.
export const DEFAULT_PERMISSION_MODE: string = 'auto';

/** Modes a supervised worker may run under. `plan` and `manual` cannot act; `dontAsk` and
 * `acceptEdits` can, under the floor. Anything not on this list is refused rather than passed
 * through to the CLI — an unrecognised posture must not become a permissive one. */
export const SUPERVISED_PERMISSION_MODES = [
  'auto',
  'acceptEdits',
  'dontAsk',
  'bypassPermissions',
] as const;

export interface PermissionPosture {
  mode: string;
  /** True only for `bypassPermissions` — the one posture where the floor does not apply. */
  bypassed: boolean;
  /** Where the mode came from, for the journal and for `pnpm autopilot status`. */
  source: string;
}

/**
 * Resolve the worker permission mode from the environment, failing closed on anything the
 * supervisor does not recognise. Returns an error rather than a mode so the caller must decide
 * what to do about it; there is no fallback that quietly widens the posture.
 */
export function resolvePermissionPosture(
  env: NodeJS.ProcessEnv,
): PermissionPosture | { error: string } {
  const raw = env.AUTOPILOT_PERMISSION_MODE;
  if (raw === undefined || raw === '') {
    return {
      mode: DEFAULT_PERMISSION_MODE,
      bypassed: false,
      source: 'default (fail closed)',
    };
  }
  if (!(SUPERVISED_PERMISSION_MODES as readonly string[]).includes(raw)) {
    return {
      error:
        `AUTOPILOT_PERMISSION_MODE="${raw}" is not one of ` +
        `${SUPERVISED_PERMISSION_MODES.join(' | ')}. Refusing to start: an unrecognised ` +
        'permission posture must not fall back to a permissive one.',
    };
  }
  return {
    mode: raw,
    bypassed: raw === 'bypassPermissions',
    source: 'AUTOPILOT_PERMISSION_MODE (explicit opt-in)',
  };
}

/**
 * Build the argv for a real Claude worker.
 *
 * `--session-id` is supplied rather than discovered so the supervisor can name the session in
 * durable state BEFORE the process exists — a worker that dies in its first second is still
 * addressable for `claude --resume`. `--print` makes it non-interactive; there is nobody to
 * answer a prompt.
 *
 * The permission mode is `auto` and the deny/allow floor rides along on `--settings`. Neither
 * is defaulted here: `opts.permissionMode` arrives already resolved by
 * `resolvePermissionPosture`, and an absent one falls back to the closed default rather than to
 * the open one. See that function for why the classifier alone is not enough.
 *
 * The brief is NOT an argument. It is multi-kilobyte Markdown with newlines, quotes and
 * backticks, and Windows resolves `claude` through a `.cmd` shim that needs a shell — putting
 * the brief on that command line is a quoting bug waiting for the first backtick. It goes to
 * the child's stdin instead, which `--print` reads when no prompt argument is given.
 */
export function claudeLaunch(spec: WorkerSpec, opts: ClaudeOptions = {}): LaunchCommand {
  const args = ['--print', '--output-format', 'stream-json', '--verbose'];
  if (spec.resumeSessionId !== undefined) {
    args.push('--resume', spec.resumeSessionId, '--fork-session');
  } else {
    args.push('--session-id', spec.sessionId);
  }
  args.push('--permission-mode', opts.permissionMode ?? DEFAULT_PERMISSION_MODE);
  if (opts.permissionsFile !== undefined) args.push('--settings', opts.permissionsFile);
  if (opts.model !== undefined) args.push('--model', opts.model);
  if (opts.maxBudgetUsd !== undefined) args.push('--max-budget-usd', opts.maxBudgetUsd);
  return {
    command: process.env.AUTOPILOT_CLAUDE_BIN ?? 'claude',
    args,
    env: {
      ...process.env,
      AUTOPILOT_WORKER_ID: spec.workerId,
      AUTOPILOT_REPORT_PATH: spec.reportPath,
      AUTOPILOT_TASK: spec.task,
      AUTOPILOT_NODE: spec.node ?? '',
      AUTOPILOT_SESSION_ID: spec.sessionId,
    },
  };
}

/**
 * `AUTOPILOT_WORKER_CMD` replaces the whole launcher — the executable, plus any arguments in
 * `AUTOPILOT_WORKER_ARGS` (space-separated). The brief reaches it on stdin and the same
 * `AUTOPILOT_*` environment reaches it, exactly as for a real session. That is the seam the
 * scenarios use.
 */
export function resolveLaunch(
  spec: WorkerSpec,
  env: NodeJS.ProcessEnv,
  opts: ClaudeOptions = {},
): LaunchCommand {
  const override = env.AUTOPILOT_WORKER_CMD;
  if (override === undefined || override === '') return claudeLaunch(spec, opts);
  const extra = (env.AUTOPILOT_WORKER_ARGS ?? '').split(' ').filter((a) => a !== '');
  return {
    command: override,
    args: extra,
    env: {
      ...env,
      AUTOPILOT_WORKER_ID: spec.workerId,
      AUTOPILOT_REPORT_PATH: spec.reportPath,
      AUTOPILOT_TASK: spec.task,
      AUTOPILOT_NODE: spec.node ?? '',
      AUTOPILOT_SESSION_ID: spec.sessionId,
    },
  };
}

/**
 * A single command line for the one case that needs a shell.
 *
 * `spawn(cmd, args, { shell: true })` concatenates the array without escaping — Node warns
 * about it (DEP0190) and will eventually refuse. So the quoting happens here instead, over an
 * argv this file built: fixed flags, a UUID, a model alias, a permission mode. Anything with a
 * character a shell would reinterpret is a bug in the caller, not something to quote around, so
 * it throws rather than being smuggled through. The brief — the one genuinely unbounded string
 * — never reaches this function; it goes down stdin.
 */
export function shellCommandLine(launch: LaunchCommand): string {
  // A denylist, not an allowlist: a repository path may legitimately contain a space, and a
  // space inside double quotes is safe on both cmd.exe and sh. What is never safe is a
  // character that closes the quoting or starts an expansion.
  const unsafe = launch.args.filter((a) => /["%$`\r\n]/.test(a));
  if (unsafe.length > 0) {
    throw new Error(
      `refusing to build a shell command line containing ${JSON.stringify(unsafe)} — ` +
        'a worker argument with shell metacharacters is a bug, not something to escape',
    );
  }
  return [launch.command, ...launch.args.map((a) => `"${a}"`)].join(' ');
}

export interface RunWorkerOptions {
  schemaPath: string;
  env?: NodeJS.ProcessEnv;
  claude?: ClaudeOptions;
  /** Called with each captured stdout chunk, for live progress. */
  onStdout?: (chunk: string) => void;
  /** Records the child's pid the moment it exists, so a lease can name a live process. */
  onSpawn?: (pid: number) => void;
}

/**
 * Run one worker to completion and classify what came back.
 *
 * The worker's stdout and stderr are captured to files rather than held in memory: a long
 * session's transcript is evidence, and evidence lives in a file that survives this process.
 */
export async function runWorker(spec: WorkerSpec, opts: RunWorkerOptions): Promise<WorkerResult> {
  const env = opts.env ?? process.env;
  mkdirSync(spec.sessionDir, { recursive: true });
  mkdirSync(join(spec.reportPath, '..'), { recursive: true });

  const stdoutPath = join(spec.sessionDir, 'stdout.log');
  const stderrPath = join(spec.sessionDir, 'stderr.log');
  const launch = resolveLaunch(spec, env, opts.claude);
  const started = Date.now();

  const outStream = createWriteStream(stdoutPath, { flags: 'a' });
  const errStream = createWriteStream(stderrPath, { flags: 'a' });
  let stdout = '';
  let timedOut = false;

  const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(
    (resolvePromise) => {
      // Windows resolves a bare `claude` through a `.cmd` shim, which `spawn` will not find
      // without a shell. An absolute path needs no shell and must not get one — the node binary
      // lives under `C:\Program Files\`, and a shell would split it at the space.
      const needsShell = process.platform === 'win32' && !isAbsolute(launch.command);
      const child = needsShell
        ? spawn(shellCommandLine(launch), {
            cwd: spec.cwd,
            env: launch.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
          })
        : spawn(launch.command, launch.args, {
            cwd: spec.cwd,
            env: launch.env,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
      if (child.pid !== undefined) opts.onSpawn?.(child.pid);

      // The brief goes down stdin, never onto the command line. See `claudeLaunch`.
      child.stdin.on('error', () => {
        /* a worker that ignores its stdin is not a failure of the supervisor */
      });
      child.stdin.end(spec.prompt, 'utf8');

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, spec.timeoutMs);

      child.stdout.on('data', (d: Buffer) => {
        const text = d.toString('utf8');
        stdout += text;
        outStream.write(text);
        opts.onStdout?.(text);
      });
      child.stderr.on('data', (d: Buffer) => errStream.write(d.toString('utf8')));

      child.on('error', (e: Error) => {
        errStream.write(`\n[supervisor] spawn failed: ${e.message}\n`);
        clearTimeout(timer);
        resolvePromise({ code: null, signal: null });
      });
      child.on('close', (c, s) => {
        clearTimeout(timer);
        resolvePromise({ code: c, signal: s });
      });
    },
  );

  outStream.end();
  errStream.end();

  const durationMs = Date.now() - started;
  const resultSubtype = parseResultSubtype(stdout);
  const verdict = await readReport(spec.reportPath, opts.schemaPath);

  if (verdict.ok && verdict.report) {
    return {
      workerId: spec.workerId,
      sessionId: verdict.report.sessionId ?? spec.sessionId,
      task: spec.task,
      node: spec.node,
      outcome: verdict.report.outcome,
      report: verdict.report,
      derivedFrom: `outcome envelope ${spec.reportPath}`,
      exitCode: code,
      signal,
      timedOut,
      durationMs,
      stdoutPath,
      stderrPath,
      reportPath: spec.reportPath,
      resultSubtype,
    };
  }

  // No usable envelope. Say exactly why, and never upgrade the outcome above FAILED — the
  // supervisor decides whether that becomes another attempt.
  const why = timedOut
    ? `killed after ${String(spec.timeoutMs)}ms without writing an outcome envelope`
    : code === 0
      ? `exited 0 without a valid outcome envelope (${verdict.errors.join('; ')})`
      : `exited ${String(code)}${signal ? ` on ${signal}` : ''} (${verdict.errors.join('; ')})`;

  return {
    workerId: spec.workerId,
    sessionId: spec.sessionId,
    task: spec.task,
    node: spec.node,
    outcome: 'FAILED',
    report: null,
    derivedFrom: why,
    exitCode: code,
    signal,
    timedOut,
    durationMs,
    stdoutPath,
    stderrPath,
    reportPath: spec.reportPath,
    resultSubtype,
  };
}
