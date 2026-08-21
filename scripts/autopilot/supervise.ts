/**
 * The supervisor loop.
 *
 * It is thin on purpose. Every question it asks already has a deterministic answer somewhere
 * in this repository, and the loop's only job is to ask in the right order and act on what
 * comes back:
 *
 *   what happens next?      `pnpm flow next`        — probes, gate records, handoffs
 *   sequential or parallel? `pnpm lanes decide`     — via the flow action's `mode`
 *   what is this packet?    `pnpm oracle packet`    — sliced by the worker, not inlined here
 *   are the gates green?    `pnpm gates`            — run here, by the supervisor
 *   may this phase advance? `progression.ts`        — the invariant, as a total function
 *
 * The one rule that shapes all of it: **a worker is never authoritative about progression.**
 * A worker reports what it did; the supervisor re-asks the repository whether that changed
 * anything. `DONE` in an outcome envelope moves a node no further than "the probes may now
 * pass" — and the probes are then re-run. A gate is recorded only after the deterministic
 * command exits 0 AND the invariant in `progression.ts` holds over every mandatory source.
 *
 * Nothing here decides a phase, a wave or a dispatch by judgement. `CLAUDE.md` ## Dispatch:
 * never dispatch by judgement; `pnpm flow next` is the entry point.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import type { FlowAction } from '../flow.ts';
import {
  appendJournal,
  clearStop,
  loadOrInit,
  repairKey,
  stopRequested,
  unresolvedFailures,
  writeState,
  type BlockingFailure,
  type Escalation,
  type NodeRecord,
  type SupervisorState,
} from './state.ts';
import {
  acquireLease,
  reapExpired,
  releaseLease,
  DEFAULT_LEASE_TTL_MS,
  type LeaseHolder,
} from './lease.ts';
import {
  green,
  phaseVerdict,
  red,
  renderVerdict,
  waveVerdict,
  type Sources,
  type Verdict,
} from './progression.ts';
import { buildBrief } from './bootstrap.ts';
import { describeRepairPolicy, standingPolicy, type RepairPolicy } from './repair-policy.ts';
import {
  newSessionId,
  newWorkerId,
  runWorker,
  type ClaudeOptions,
  type PermissionPosture,
  type WorkerResult,
  type WorkerSpec,
  type WorkerTask,
} from './worker.ts';

export interface CommandResult {
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface SuperviseOptions {
  root: string;
  stateDir: string;
  /** Hard stop on the loop itself. A supervisor that never returns cannot be reasoned about. */
  maxIterations: number;
  /**
   * How many materially different, evidence-driven strategies before trigger 5 fires, and the
   * rule that set that number. An attempt IS a strategy — `scripts/autopilot/repair-policy.ts`
   * is where that is stated once and where a widened bound has to name its authority.
   */
  repair: RepairPolicy;
  /** The resolved worker permission posture, recorded so a bypassed run can never look normal. */
  permission: PermissionPosture;
  /** Rotations allowed on one node before a rotation is treated as a spent repair attempt. */
  maxRotations: number;
  /** Concurrent workers when the lane decision says parallel. */
  concurrency: number;
  workerTimeoutMs: number;
  leaseTtlMs: number;
  /** Repeats of an identical derived action before the run is declared stuck. */
  noProgressLimit: number;
  dryRun: boolean;
}

export const DEFAULT_OPTIONS: Omit<SuperviseOptions, 'root' | 'stateDir'> = {
  maxIterations: 200,
  repair: standingPolicy(),
  permission: { mode: 'auto', bypassed: false, source: 'default (fail closed)' },
  maxRotations: 8,
  concurrency: 3,
  workerTimeoutMs: 90 * 60_000,
  leaseTtlMs: DEFAULT_LEASE_TTL_MS,
  noProgressLimit: 6,
  dryRun: false,
};

export interface SuperviseDeps {
  now: () => Date;
  /** Default: `flow.nextAction()`. The supervisor never re-derives this in prose. */
  deriveAction: () => Promise<FlowAction>;
  /** Default: a real shell. Injected by the scenarios so a gate can be made RED on demand. */
  runCommand: (command: string, cwd: string) => CommandResult;
  /** Default: `runWorker`. Injected so process-boundary scenarios cost nothing. */
  launchWorker: (spec: WorkerSpec) => Promise<WorkerResult>;
  log: (line: string) => void;
}

export type SuperviseStatus = 'COMPLETE' | 'ESCALATED' | 'STOPPED' | 'ITERATION_LIMIT' | 'DRY_RUN';

export interface SuperviseResult {
  status: SuperviseStatus;
  iterations: number;
  state: SupervisorState;
  lastAction: FlowAction | null;
  escalation: Escalation | null;
}

// ── evidence layout ───────────────────────────────────────────────────────────────────

/** Control state lives in `.autopilot/`; evidence lives where all other evidence lives. */
export function evidenceDir(root: string, runId: string): string {
  return join(root, '.artifacts/evidence/autopilot', runId);
}

function relativeToRoot(root: string, path: string): string {
  const r = resolve(root);
  const p = resolve(path);
  return p.startsWith(r) ? p.slice(r.length + 1).replace(/\\/g, '/') : p.replace(/\\/g, '/');
}

function captureCommand(root: string, runId: string, label: string, r: CommandResult): string {
  const dir = evidenceDir(root, runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${label}.log`);
  writeFileSync(
    path,
    [
      `$ ${r.command}`,
      `EXIT=${String(r.code)}`,
      `DURATION_MS=${String(r.durationMs)}`,
      '',
      '--- stdout ---',
      r.stdout,
      '--- stderr ---',
      r.stderr,
      '',
    ].join('\n'),
    'utf8',
  );
  return relativeToRoot(root, path);
}

/**
 * A Definition-of-Done artifact the phase-gate worker produced, checked mechanically. The
 * worker cannot pass this by asserting success: the document has to carry bound checkboxes
 * and none of the words that mean "not actually verified".
 *
 * `CLAUDE.md`: deferred, skipped and unknown are all unverified.
 */
export function checkDodArtifact(path: string): { ok: boolean; why: string } {
  if (!existsSync(path)) return { ok: false, why: `no Definition-of-Done artifact at ${path}` };
  const text = readFileSync(path, 'utf8');
  const bound = (text.match(/^\s*[-*]\s*\[[xX]\]/gm) ?? []).length;
  const unbound = (text.match(/^\s*[-*]\s*\[ \]/gm) ?? []).length;
  if (bound === 0) return { ok: false, why: `${path} binds no Definition-of-Done checkbox` };
  if (unbound > 0) {
    return { ok: false, why: `${path} leaves ${String(unbound)} checkbox(es) unchecked` };
  }
  const forbidden = ['NOT MET', 'UNVERIFIED', 'deferred', 'skipped'];
  const hit = forbidden.find((w) => text.includes(w));
  if (hit !== undefined) {
    return { ok: false, why: `${path} says "${hit}" — unverified is not met` };
  }
  return { ok: true, why: `${path}: ${String(bound)} checkbox(es), each bound` };
}

/** Every path a gate record will point at must exist and carry something. */
export function checkEvidencePaths(root: string, paths: string[]): { ok: boolean; why: string } {
  if (paths.length === 0) return { ok: false, why: 'the gate cites no evidence at all' };
  const missing: string[] = [];
  const empty: string[] = [];
  for (const p of paths) {
    const full = resolve(root, p);
    if (!existsSync(full)) {
      missing.push(p);
      continue;
    }
    try {
      if (statSync(full).isFile() && statSync(full).size === 0) empty.push(p);
    } catch {
      missing.push(p);
    }
  }
  if (missing.length > 0) return { ok: false, why: `missing evidence: ${missing.join(', ')}` };
  if (empty.length > 0) return { ok: false, why: `empty evidence: ${empty.join(', ')}` };
  return { ok: true, why: `${String(paths.length)} evidence path(s) present` };
}

// ── escalation ────────────────────────────────────────────────────────────────────────

/**
 * Which `CLAUDE.md` ## Plan discipline trigger a supervisor-side dead end maps to. Written
 * down rather than chosen per site, so a widened trigger is a diff and not a decision made
 * twice.
 */
export const TRIGGER = {
  /** A broken delivery graph: correcting it changes what scope was approved. */
  graphConfig: 2,
  /** Nothing dispatchable and work outstanding — the remaining choice is the human's. */
  deadEndDependency: 3,
  /** Repair bound reached with the gate still RED. */
  repairExhausted: 5,
  /** The loop is deriving the same action with nothing changing. */
  noProgress: 5,
} as const;

export function renderEscalation(e: Escalation): string {
  return [
    'AUTOPILOT_BLOCKED',
    '',
    `phase: ${e.segment ?? '-'}`,
    `node: ${e.node ?? '-'}`,
    `trigger: ${String(e.trigger)}`,
    `reason: ${e.reason}`,
    '',
    'options:',
    ...e.options.map((o, i) => `${String.fromCharCode(65 + i)}: ${o}`),
    '',
    'evidence:',
    ...(e.evidence.length > 0 ? e.evidence.map((p) => `  ${p}`) : ['  (none recorded)']),
    '',
    `raised: ${e.at}`,
    '',
    'Once the decision is supplied, `pnpm autopilot resume --note "<decision>"` continues from',
    'durable state. Nothing in this run mutates further until then.',
    '',
  ].join('\n');
}

// ── the loop ──────────────────────────────────────────────────────────────────────────

interface Ctx {
  opts: SuperviseOptions;
  deps: SuperviseDeps;
  holder: LeaseHolder;
  schemaPath: string;
  state: SupervisorState;
}

function save(ctx: Ctx, mutate: (s: SupervisorState) => SupervisorState): void {
  ctx.state = writeState(ctx.opts.stateDir, mutate(ctx.state), ctx.deps.now());
}

function journal(
  ctx: Ctx,
  transition: string,
  extra: Partial<{
    action: string;
    segment: string | null;
    node: string | null;
    outcome: string;
    evidence: string[];
    detail: string;
  }> = {},
): void {
  appendJournal(ctx.opts.stateDir, {
    at: ctx.deps.now().toISOString(),
    runId: ctx.state.runId,
    transition,
    ...extra,
  });
}

function recordFailure(ctx: Ctx, f: Omit<BlockingFailure, 'id' | 'at'>): BlockingFailure {
  const failure: BlockingFailure = {
    ...f,
    id: randomUUID().slice(0, 8),
    at: ctx.deps.now().toISOString(),
  };
  save(ctx, (s) => ({ ...s, blockingFailures: [...s.blockingFailures, failure] }));
  journal(ctx, 'RED -> failure recorded', {
    segment: failure.segment,
    node: failure.node,
    detail: failure.detail,
    evidence: failure.evidence,
  });
  ctx.deps.log(`  RED  ${failure.kind}: ${failure.detail}`);
  return failure;
}

function resolveFailures(ctx: Ctx, predicate: (f: BlockingFailure) => boolean): void {
  const at = ctx.deps.now().toISOString();
  save(ctx, (s) => ({
    ...s,
    blockingFailures: s.blockingFailures.map((f) =>
      f.resolvedAt === undefined && predicate(f) ? { ...f, resolvedAt: at } : f,
    ),
  }));
}

function escalate(ctx: Ctx, e: Omit<Escalation, 'at'>): Escalation {
  const escalation: Escalation = { ...e, at: ctx.deps.now().toISOString() };
  save(ctx, (s) => ({ ...s, escalation }));
  const dir = join(ctx.opts.stateDir, 'escalations');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${escalation.at.replace(/[:.]/g, '-')}.md`),
    renderEscalation(escalation),
    'utf8',
  );
  journal(ctx, 'RUNNING -> ESCALATED', {
    segment: escalation.segment,
    node: escalation.node,
    detail: escalation.reason,
    evidence: escalation.evidence,
  });
  ctx.deps.log('');
  ctx.deps.log(renderEscalation(escalation));
  return escalation;
}

function setNode(ctx: Ctx, node: string, patch: Partial<NodeRecord>): void {
  save(ctx, (s) => {
    const prev: NodeRecord = s.nodes[node] ?? {
      status: 'READY',
      launches: 0,
      updatedAt: ctx.deps.now().toISOString(),
    };
    return {
      ...s,
      nodes: {
        ...s.nodes,
        [node]: { ...prev, ...patch, updatedAt: ctx.deps.now().toISOString() },
      },
    };
  });
}

function bumpRepair(ctx: Ctx, segment: string | null, node: string | null): number {
  const key = repairKey(segment, node);
  const next = (ctx.state.repairAttempts[key] ?? 0) + 1;
  save(ctx, (s) => ({ ...s, repairAttempts: { ...s.repairAttempts, [key]: next } }));
  return next;
}

function repairsSpent(ctx: Ctx, segment: string | null, node: string | null): number {
  return ctx.state.repairAttempts[repairKey(segment, node)] ?? 0;
}

// ── worker dispatch ───────────────────────────────────────────────────────────────────

function handoffsFor(root: string, node: string | null): string[] {
  const out: string[] = [];
  const laneDir = join(root, '.artifacts/handoffs');
  try {
    for (const f of readdirSync(laneDir)) {
      if (!f.endsWith('.json')) continue;
      if (node !== null && !f.includes(node)) continue;
      out.push(`.artifacts/handoffs/${f}`);
    }
  } catch {
    /* no handoffs yet is the normal early case */
  }
  const sessionDir = join(root, '.artifacts/handoffs/session');
  try {
    const briefs = readdirSync(sessionDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, m: statSync(join(sessionDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 2);
    for (const b of briefs) out.push(`.artifacts/handoffs/session/${b.f}`);
  } catch {
    /* likewise */
  }
  return out;
}

function decisionsFor(root: string): string[] {
  try {
    return readdirSync(join(root, 'docs/decisions'))
      .filter((f) => /^\d{4}-/.test(f))
      .map((f) => `docs/decisions/${f}`);
  } catch {
    return [];
  }
}

async function dispatchWorker(
  ctx: Ctx,
  task: WorkerTask,
  node: string | null,
  action: FlowAction,
  attempt: number,
): Promise<WorkerResult> {
  const workerId = newWorkerId(task, node);
  const sessionId = newSessionId();
  const sessionDir = join(ctx.opts.stateDir, 'sessions', workerId);
  const reportPath = join(ctx.opts.stateDir, 'handoffs', `${workerId}.json`);
  const segment = action.segment ?? ctx.state.segment;

  const prompt = buildBrief({
    task,
    node,
    segment,
    action,
    reportPath,
    workerId,
    attempt,
    maxAttempts: ctx.opts.repair.bound,
    state: ctx.state,
    failures: unresolvedFailures(ctx.state),
    handoffs: handoffsFor(ctx.opts.root, node),
    decisions: decisionsFor(ctx.opts.root),
    steps: action.steps ?? [],
  });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'brief.md'), prompt, 'utf8');

  const spec: WorkerSpec = {
    workerId,
    sessionId,
    task,
    node,
    segment,
    prompt,
    reportPath,
    sessionDir,
    cwd: ctx.opts.root,
    timeoutMs: ctx.opts.workerTimeoutMs,
  };

  if (node !== null)
    setNode(ctx, node, { status: 'RUNNING', lastWorkerId: workerId, lastSessionId: sessionId });
  journal(ctx, 'READY -> RUNNING', {
    action: action.action,
    segment,
    node,
    detail: `worker ${workerId} session ${sessionId} (${task}, attempt ${String(attempt)})`,
    evidence: [relativeToRoot(ctx.opts.root, join(sessionDir, 'brief.md'))],
  });
  ctx.deps.log(`  -> worker ${workerId} (${task}${node ? ` ${node}` : ''}) session ${sessionId}`);

  const result = await ctx.deps.launchWorker(spec);

  if (node !== null) {
    setNode(ctx, node, {
      lastOutcome: result.outcome,
      launches: (ctx.state.nodes[node]?.launches ?? 0) + 1,
    });
  }
  journal(ctx, `RUNNING -> ${result.outcome}`, {
    action: action.action,
    segment,
    node,
    outcome: result.outcome,
    detail: result.derivedFrom,
    evidence: [
      relativeToRoot(ctx.opts.root, result.stdoutPath),
      ...(result.report?.evidence ?? []),
    ],
  });
  ctx.deps.log(`  <- ${result.outcome}  ${result.report?.summary ?? result.derivedFrom}`);
  return result;
}

/** Take the lease, run the worker, always release. A lease outliving its worker is the bug. */
async function withLease<T>(
  ctx: Ctx,
  key: string,
  workerIdFor: (leaseWorkerId: string) => Promise<T>,
): Promise<T | null> {
  const leaseWorkerId = `${ctx.state.runId}:${key}:${randomUUID().slice(0, 6)}`;
  const got = acquireLease(
    ctx.opts.stateDir,
    key,
    { ...ctx.holder, workerId: leaseWorkerId },
    { ttlMs: ctx.opts.leaseTtlMs, now: ctx.deps.now() },
  );
  if (!got.ok) {
    ctx.deps.log(`  .. ${key} is owned by ${got.held.workerId} — ${got.reason}`);
    journal(ctx, 'READY -> skipped (leased)', { node: key, detail: got.reason });
    return null;
  }
  try {
    return await workerIdFor(leaseWorkerId);
  } finally {
    releaseLease(ctx.opts.stateDir, key, leaseWorkerId);
  }
}

// ── gates ─────────────────────────────────────────────────────────────────────────────

interface GateOutcome {
  recorded: boolean;
  verdict: Verdict;
  sources: Sources;
  evidence: string[];
}

/**
 * Run a gate end to end: the deterministic command first, then — only if it was green — the
 * agent work the cadence requires, then the invariant, then the record.
 *
 * The order matters. `pnpm gates` is cheap relative to a worker and catches most of what a
 * worker would otherwise spend tokens discovering (`CLAUDE.md` ## Agents). And a gate whose
 * command was RED never reaches a worker at all, so no amount of agent confidence can carry
 * it forward.
 */
async function runGate(ctx: Ctx, action: FlowAction, kind: 'wave' | 'phase'): Promise<GateOutcome> {
  const segment = action.segment ?? ctx.state.segment;
  const command = kind === 'phase' ? 'pnpm gates:full' : 'pnpm gates';
  ctx.deps.log(`  running ${command} for segment ${segment ?? '?'} (${kind} gate)`);
  const r = ctx.deps.runCommand(command, ctx.opts.root);
  const gateLog = captureCommand(
    ctx.opts.root,
    ctx.state.runId,
    `${segment ?? 'unknown'}-${kind}-gate-command`,
    r,
  );

  // `nodes` is measured here rather than inherited from the action. `pnpm flow next` already
  // resolved the graph once, at derive time; re-probing at gate time is a second independent
  // reading with its own artifact. Without it the row would be a restatement of the action
  // that asked for the gate, cited against evidence that bears on the gate command instead —
  // exactly the "evidence offered for a criterion it does not touch" that `pnpm lanes handoff`
  // rejects in a lane report.
  const probe = ctx.deps.runCommand('pnpm oracle status', ctx.opts.root);
  const nodesLog = captureCommand(
    ctx.opts.root,
    ctx.state.runId,
    `${segment ?? 'unknown'}-${kind}-gate-nodes`,
    probe,
  );

  const sources: Sources = {
    nodes:
      probe.code === 0
        ? green(
            `pnpm oracle status exit 0, re-probed at gate time; pnpm flow next returned ` +
              `${action.action}, which it only does with every packet DONE by probe`,
            [nodesLog],
          )
        : red(`pnpm oracle status exit ${String(probe.code)} — the probes cannot be read`, [
            nodesLog,
          ]),
    gates:
      r.code === 0
        ? green(`${command} exit 0`, [gateLog])
        : red(`${command} exit ${String(r.code)}`, [gateLog]),
    failureEvidence:
      unresolvedFailures(ctx.state).length === 0
        ? green('no unresolved blocking failure recorded for this run', [gateLog])
        : red(
            `${String(unresolvedFailures(ctx.state).length)} unresolved blocking failure(s)`,
            unresolvedFailures(ctx.state).flatMap((f) => f.evidence),
          ),
  };

  const summarise = (v: Verdict): string => {
    const path = join(
      evidenceDir(ctx.opts.root, ctx.state.runId),
      `${segment ?? 'unknown'}-${kind}-gate-verdict.md`,
    );
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(
      path,
      [
        `# ${kind} gate — segment ${segment ?? '?'}`,
        '',
        `Derived at ${ctx.deps.now().toISOString()} by supervisor run ${ctx.state.runId}.`,
        '',
        ...renderVerdict(v, sources),
        '',
      ].join('\n'),
      'utf8',
    );
    return relativeToRoot(ctx.opts.root, path);
  };

  if (r.code !== 0) {
    // The false-green case, refused at its only entry point: the deterministic command is
    // RED, so no gate worker runs, no record is written, and the phase does not advance
    // however many nodes are DONE.
    const verdict = kind === 'phase' ? phaseVerdict(sources) : waveVerdict(sources);
    return { recorded: false, verdict, sources, evidence: [gateLog, summarise(verdict)] };
  }

  const dodPath = join(
    ctx.opts.root,
    '.artifacts/evidence',
    segment ?? 'unknown',
    `${kind}-gate`,
    'definition-of-done.md',
  );
  const worker = await dispatchWorker(
    ctx,
    kind === 'phase' ? 'phase-gate' : 'wave-gate',
    null,
    {
      ...action,
      steps: [...(action.steps ?? []), `write ${relativeToRoot(ctx.opts.root, dodPath)}`],
    },
    repairsSpent(ctx, segment, null) + 1,
  );

  const workerEvidence = (worker.report?.evidence ?? []).filter((p) => p.trim() !== '');
  const agentSource =
    worker.outcome === 'DONE'
      ? green(`gate worker ${worker.workerId} reported DONE`, [
          relativeToRoot(ctx.opts.root, worker.reportPath),
          ...workerEvidence,
        ])
      : red(`gate worker ${worker.workerId} reported ${worker.outcome}: ${worker.derivedFrom}`, [
          relativeToRoot(ctx.opts.root, worker.stdoutPath),
        ]);

  if (kind === 'wave') {
    sources.validation = agentSource;
  } else {
    const dod = checkDodArtifact(dodPath);
    sources.definitionOfDone =
      worker.outcome === 'DONE' && dod.ok
        ? green(`validate-phase artifact, checked mechanically: ${dod.why}`, [
            relativeToRoot(ctx.opts.root, dodPath),
          ])
        : red(dod.ok ? `gate worker reported ${worker.outcome}` : dod.why, [
            relativeToRoot(ctx.opts.root, worker.stdoutPath),
          ]);
  }

  const candidate = [gateLog, ...(agentSource.verdict === 'GREEN' ? agentSource.evidence : [])];
  const evidence = [...new Set(candidate)];
  if (kind === 'phase') {
    const present = checkEvidencePaths(ctx.opts.root, evidence);
    sources.artifacts = present.ok
      ? green(`every cited evidence path exists and is non-empty: ${present.why}`, evidence)
      : red(present.why, [gateLog]);
  }

  const verdict = kind === 'phase' ? phaseVerdict(sources) : waveVerdict(sources);
  const withSummary = [...new Set([...evidence, summarise(verdict)])];

  if (!verdict.green) {
    return { recorded: false, verdict, sources, evidence: withSummary };
  }

  // Recording composes the existing tool rather than writing the JSON here: `pnpm flow record`
  // re-checks that every evidence path exists, so the record cannot outlive its proof.
  const packets = action.packets ?? [];
  const cmd =
    kind === 'phase'
      ? `pnpm flow record phase --segment ${segment ?? ''} --evidence ${withSummary.join(' ')}`
      : `pnpm flow record wave --segment ${segment ?? ''} --packets ${packets.join(' ')} --evidence ${withSummary.join(' ')}`;
  const rec = ctx.deps.runCommand(cmd, ctx.opts.root);
  captureCommand(
    ctx.opts.root,
    ctx.state.runId,
    `${segment ?? 'unknown'}-${kind}-gate-record`,
    rec,
  );
  if (rec.code !== 0) {
    return {
      recorded: false,
      verdict: {
        ...verdict,
        green: false,
        verdict: kind === 'phase' ? 'HOLD_PHASE' : 'HOLD_WAVE',
        blockers: [
          ...verdict.blockers,
          {
            source: 'record',
            verdict: 'RED',
            why: `pnpm flow record exited ${String(rec.code)}: ${rec.stderr.trim()}`,
          },
        ],
      },
      sources,
      evidence: withSummary,
    };
  }
  journal(ctx, kind === 'phase' ? 'DONE -> PHASE_GREEN' : 'DONE -> WAVE_GREEN', {
    action: action.action,
    segment,
    evidence: withSummary,
    detail: cmd,
  });
  return { recorded: true, verdict, sources, evidence: withSummary };
}

// ── action handlers ───────────────────────────────────────────────────────────────────

interface StepResult {
  terminal: SuperviseStatus | null;
  escalation?: Escalation;
}

const CONTINUE: StepResult = { terminal: null };

function escalationForRepairExhaustion(
  ctx: Ctx,
  segment: string | null,
  node: string | null,
  spent: number,
  evidence: string[],
  detail: string,
): StepResult {
  const e = escalate(ctx, {
    trigger: TRIGGER.repairExhausted,
    segment,
    node,
    reason:
      `${String(spent)} materially different repair attempt(s) spent on ` +
      `${node ?? `the ${segment ?? '?'} gate`} and it is still RED. ` +
      `Bound: ${describeRepairPolicy(ctx.opts.repair)}. ${detail}`,
    options: [
      'supply the missing diagnosis or decision, then `pnpm autopilot resume`',
      "change the packet's scope or acceptance criteria in the plan, then resume",
      'stop the run and take this node manually',
    ],
    evidence,
  });
  return { terminal: 'ESCALATED', escalation: e };
}

async function handleGate(
  ctx: Ctx,
  action: FlowAction,
  kind: 'wave' | 'phase',
): Promise<StepResult> {
  const segment = action.segment ?? ctx.state.segment;
  const outcome = await runGate(ctx, action, kind);
  ctx.deps.log(`  ${outcome.verdict.verdict}`);
  for (const b of outcome.verdict.blockers) ctx.deps.log(`     ${b.source}: ${b.why}`);

  if (outcome.recorded) {
    resolveFailures(ctx, (f) => f.segment === segment && f.kind === 'gate');
    const head = ctx.deps.runCommand('git rev-parse HEAD', ctx.opts.root);
    save(ctx, (s) => ({
      ...s,
      lastGreenCommit: head.code === 0 ? head.stdout.trim() : s.lastGreenCommit,
    }));
    return CONTINUE;
  }

  const failure = recordFailure(ctx, {
    kind: 'gate',
    segment,
    node: null,
    detail: `${kind} gate held: ${outcome.verdict.blockers.map((b) => `${b.source} ${b.why}`).join('; ')}`,
    evidence: outcome.evidence,
  });
  const spent = bumpRepair(ctx, segment, null);
  if (spent > ctx.opts.repair.bound) {
    return escalationForRepairExhaustion(
      ctx,
      segment,
      null,
      spent - 1,
      outcome.evidence,
      failure.detail,
    );
  }
  // A held gate is ordinary work. The next iteration derives the same gate action, and the
  // repair worker below runs first because the failure is now on the record.
  const repair = await withLease(ctx, `${segment ?? 'unknown'}::gate`, () =>
    dispatchWorker(ctx, 'repair', null, action, spent),
  );
  if (repair?.outcome === 'BLOCKED' && repair.report) {
    return {
      terminal: 'ESCALATED',
      escalation: escalate(ctx, {
        trigger: repair.report.trigger ?? TRIGGER.repairExhausted,
        segment,
        node: null,
        reason: repair.report.summary,
        options: repair.report.options ?? [],
        evidence: repair.report.evidence ?? outcome.evidence,
      }),
    };
  }
  return CONTINUE;
}

async function handleDispatch(ctx: Ctx, action: FlowAction): Promise<StepResult> {
  const segment = action.segment ?? ctx.state.segment;
  const packets = action.packets ?? [];
  if (packets.length === 0) return CONTINUE;

  const parallel = action.mode === 'parallel';
  const batch = parallel ? packets.slice(0, ctx.opts.concurrency) : packets.slice(0, 1);
  ctx.deps.log(
    `  ${action.mode ?? 'sequential'}: ${batch.join(', ')}${
      batch.length < packets.length ? ` (of ${String(packets.length)})` : ''
    }`,
  );

  const runOne = async (node: string): Promise<WorkerResult | null> =>
    withLease(ctx, node, async () => {
      const record = ctx.state.nodes[node];
      const isRepair = record?.status === 'REPAIR';
      const spent = repairsSpent(ctx, segment, node);
      return dispatchWorker(ctx, isRepair ? 'repair' : 'dispatch', node, action, spent + 1);
    });

  const results = parallel
    ? await Promise.all(batch.map(runOne))
    : await batch.reduce<Promise<(WorkerResult | null)[]>>(
        async (acc, node) => [...(await acc), await runOne(node)],
        Promise.resolve([]),
      );

  for (const result of results) {
    if (result === null) continue;
    const node = result.node;
    if (node === null) continue;

    switch (result.outcome) {
      case 'DONE':
        // Claimed, not derived. The next `pnpm flow next` re-runs the probes and decides
        // whether this node is actually done, or needs integrating, or is still open.
        setNode(ctx, node, { status: 'READY' });
        resolveFailures(ctx, (f) => f.node === node);
        break;

      case 'ROTATE': {
        const launches = ctx.state.nodes[node]?.launches ?? 0;
        setNode(ctx, node, { status: 'READY' });
        journal(ctx, 'RUNNING -> ROTATE', {
          node,
          segment,
          detail: `rotation ${String(launches)} of ${String(ctx.opts.maxRotations)}; continuing in a fresh worker`,
          evidence: result.report?.handoff !== undefined ? [result.report.handoff] : [],
        });
        if (launches >= ctx.opts.maxRotations) {
          const spent = bumpRepair(ctx, segment, node);
          setNode(ctx, node, { status: 'REPAIR', launches: 0 });
          if (spent > ctx.opts.repair.bound) {
            return escalationForRepairExhaustion(
              ctx,
              segment,
              node,
              spent - 1,
              [relativeToRoot(ctx.opts.root, result.stdoutPath)],
              `${String(launches)} rotations without the node completing.`,
            );
          }
        }
        break;
      }

      case 'REPAIR_REQUIRED':
      case 'FAILED': {
        const spent = bumpRepair(ctx, segment, node);
        setNode(ctx, node, { status: 'REPAIR' });
        recordFailure(ctx, {
          kind: 'worker',
          segment,
          node,
          detail: `${result.outcome}: ${result.report?.summary ?? result.derivedFrom}`,
          evidence: [
            relativeToRoot(ctx.opts.root, result.stdoutPath),
            ...(result.report?.evidence ?? []),
          ],
        });
        if (spent > ctx.opts.repair.bound) {
          return escalationForRepairExhaustion(
            ctx,
            segment,
            node,
            spent - 1,
            [relativeToRoot(ctx.opts.root, result.stdoutPath)],
            result.report?.summary ?? result.derivedFrom,
          );
        }
        break;
      }

      case 'BLOCKED':
        setNode(ctx, node, { status: 'BLOCKED' });
        return {
          terminal: 'ESCALATED',
          escalation: escalate(ctx, {
            trigger: result.report?.trigger ?? TRIGGER.deadEndDependency,
            segment,
            node,
            reason: result.report?.summary ?? result.derivedFrom,
            options: result.report?.options ?? [],
            evidence: result.report?.evidence ?? [relativeToRoot(ctx.opts.root, result.stdoutPath)],
          }),
        };
    }
  }
  return CONTINUE;
}

async function step(ctx: Ctx, action: FlowAction): Promise<StepResult> {
  const segment = action.segment ?? ctx.state.segment;

  switch (action.action) {
    case 'COMPLETE':
      journal(ctx, 'PHASE_GREEN -> COMPLETE', {
        action: action.action,
        detail: action.reason ?? '',
      });
      return { terminal: 'COMPLETE' };

    case 'ERROR':
      return {
        terminal: 'ESCALATED',
        escalation: escalate(ctx, {
          trigger: TRIGGER.graphConfig,
          segment,
          node: null,
          reason: `the delivery graph is broken: ${action.reason ?? 'unknown'}`,
          options: [
            'correct scripts/oracle/graph.json so every node lands in exactly one segment',
            'amend the approved execution order in MVP_PLAN_V3.md and regenerate the graph',
          ],
          evidence: ['scripts/oracle/graph.json'],
        }),
      };

    case 'BLOCKED':
      return {
        terminal: 'ESCALATED',
        escalation: escalate(ctx, {
          trigger: TRIGGER.deadEndDependency,
          segment,
          node: null,
          reason: `outstanding work exists and none of it is dispatchable: ${action.reason ?? ''}`,
          options: [
            'answer the open decision the blocked nodes depend on',
            'reorder or re-scope the blocked packets in the plan, then resume',
          ],
          evidence: unresolvedFailures(ctx.state).flatMap((f) => f.evidence),
        }),
      };

    case 'ADVANCE_PHASE': {
      // Deterministic and worker-free: the checkpoint is bookkeeping, and `flow next` has
      // already established that the previous segment is delivered and gated.
      const from = action.from ?? '?';
      const to = action.to ?? '?';
      updateCheckpointSegment(ctx.opts.root, to);
      save(ctx, (s) => ({ ...s, segment: to, phase: action.phase ?? s.phase }));
      journal(ctx, 'PHASE_GREEN -> ADVANCE_PHASE', {
        action: action.action,
        segment: to,
        detail: `${from} -> ${to}`,
        evidence: ['.claude/autopilot.local.md'],
      });
      ctx.deps.log(`  advanced ${from} -> ${to} (checkpoint rewritten)`);
      return CONTINUE;
    }

    case 'REPAIR': {
      const result = await withLease(ctx, `${segment ?? 'unknown'}::reconcile`, () =>
        dispatchWorker(ctx, 'reconcile', null, action, repairsSpent(ctx, segment, null) + 1),
      );
      if (result?.outcome === 'BLOCKED' && result.report) {
        return {
          terminal: 'ESCALATED',
          escalation: escalate(ctx, {
            trigger: result.report.trigger ?? TRIGGER.deadEndDependency,
            segment,
            node: null,
            reason: result.report.summary,
            options: result.report.options ?? [],
            evidence: result.report.evidence ?? [],
          }),
        };
      }
      return CONTINUE;
    }

    case 'INTEGRATE': {
      const result = await withLease(ctx, `${segment ?? 'unknown'}::integrate`, () =>
        dispatchWorker(ctx, 'integrate', null, action, 1),
      );
      if (result?.outcome === 'BLOCKED' && result.report) {
        return {
          terminal: 'ESCALATED',
          escalation: escalate(ctx, {
            trigger: result.report.trigger ?? TRIGGER.deadEndDependency,
            segment,
            node: null,
            reason: result.report.summary,
            options: result.report.options ?? [],
            evidence: result.report.evidence ?? [],
          }),
        };
      }
      return CONTINUE;
    }

    case 'DISPATCH':
      return handleDispatch(ctx, action);

    case 'WAVE_GATE':
      return handleGate(ctx, action, 'wave');

    case 'PHASE_GATE':
      return handleGate(ctx, action, 'phase');
  }
}

/**
 * Rewrite the autopilot checkpoint's segment and clear a stale `recovering` step. The
 * checkpoint stays the human-readable recovery log it always was; the supervisor only owns
 * the two frontmatter fields `pnpm flow next` reads back.
 */
export function updateCheckpointSegment(root: string, segment: string): void {
  const path = join(root, '.claude/autopilot.local.md');
  const header = `---\nphase: ${segment}\nwave: 1\nstep: framed\n---\n`;
  if (!existsSync(path)) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${header}\n## Recovery log\n`, 'utf8');
    return;
  }
  const text = readFileSync(path, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) {
    writeFileSync(path, `${header}\n${text}`, 'utf8');
    return;
  }
  const front = (m[1] ?? '')
    .split('\n')
    .map((l) =>
      l.startsWith('phase:') ? `phase: ${segment}` : l.startsWith('step:') ? 'step: framed' : l,
    )
    .join('\n');
  writeFileSync(path, `---\n${front}\n---\n${text.slice(m[0].length)}`, 'utf8');
}

// ── defaults ──────────────────────────────────────────────────────────────────────────

export function shellRunner(command: string, cwd: string): CommandResult {
  const started = Date.now();
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    command,
    code: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    durationMs: Date.now() - started,
  };
}

export function defaultDeps(
  root: string,
  schemaPath: string,
  claude: ClaudeOptions = {},
): SuperviseDeps {
  return {
    now: () => new Date(),
    deriveAction: async () => {
      const { nextAction } = await import('../flow.ts');
      return nextAction();
    },
    runCommand: shellRunner,
    launchWorker: (spec) => runWorker(spec, { schemaPath, claude }),
    log: (line) => {
      console.log(line);
    },
  };
}

// ── entry ─────────────────────────────────────────────────────────────────────────────

function signatureOf(a: FlowAction): string {
  return `${a.action}|${a.segment ?? ''}|${(a.packets ?? []).join(',')}`;
}

export async function supervise(
  options: SuperviseOptions,
  deps: SuperviseDeps,
  schemaPath: string,
): Promise<SuperviseResult> {
  const state = loadOrInit(options.stateDir, deps.now());
  const ctx: Ctx = {
    opts: options,
    deps,
    holder: { workerId: 'supervisor', runId: state.runId, pid: process.pid },
    schemaPath,
    state,
  };

  // A stop request is consumed at the start of a run, not carried into it.
  clearStop(options.stateDir);
  save(ctx, (s) => ({
    ...s,
    stopRequested: false,
    repairBound: options.repair.bound,
    repairAuthority: options.repair.authority,
    permissionMode: options.permission.mode,
    permissionBypassed: options.permission.bypassed,
  }));

  // Both safety bounds are announced and journalled before the first worker exists. A run that
  // was widened, or that skipped the permission floor entirely, must never read afterwards like
  // a run that was not.
  journal(ctx, 'START -> RUNNING', {
    detail:
      `repair bound: ${describeRepairPolicy(options.repair)}; ` +
      `permission mode: ${options.permission.mode} (${options.permission.source})`,
  });
  deps.log(`  repair bound    ${describeRepairPolicy(options.repair)}`);
  deps.log(`  permissions     ${options.permission.mode} — ${options.permission.source}`);
  if (options.permission.bypassed) {
    deps.log(
      '  WARNING         bypassPermissions skips every check, including ' +
        '.claude/autopilot-permissions.json. The CLAUDE.md escalation classes are NOT ' +
        'enforceable in this run.',
    );
  }

  let lastAction: FlowAction | null = null;
  let signature = '';
  let repeats = 0;

  for (let i = 0; i < options.maxIterations; i += 1) {
    if (stopRequested(options.stateDir)) {
      journal(ctx, 'RUNNING -> STOPPED', { detail: 'stop flag observed' });
      save(ctx, (s) => ({ ...s, stopRequested: true }));
      return { status: 'STOPPED', iterations: i, state: ctx.state, lastAction, escalation: null };
    }
    if (ctx.state.escalation !== null && ctx.state.escalation.resolvedAt === undefined) {
      return {
        status: 'ESCALATED',
        iterations: i,
        state: ctx.state,
        lastAction,
        escalation: ctx.state.escalation,
      };
    }

    for (const lease of reapExpired(options.stateDir, { now: deps.now() })) {
      journal(ctx, 'RUNNING -> lease reaped', {
        node: lease.node,
        detail: `worker ${lease.workerId} (pid ${String(lease.pid)}) is gone; node released`,
      });
      deps.log(`  reaped abandoned lease on ${lease.node} (worker ${lease.workerId})`);
    }

    const action = await deps.deriveAction();
    lastAction = action;
    save(ctx, (s) => ({
      ...s,
      nextAction: action.action,
      segment: action.segment ?? action.to ?? s.segment,
      phase: action.phase ?? s.phase,
    }));
    deps.log(
      `[${String(i + 1)}] ${action.action}${action.segment ? ` segment ${action.segment}` : ''}` +
        `${action.packets ? ` [${action.packets.join(', ')}]` : ''}`,
    );

    const sig = signatureOf(action);
    repeats = sig === signature ? repeats + 1 : 0;
    signature = sig;
    if (repeats >= options.noProgressLimit) {
      recordFailure(ctx, {
        kind: 'no-progress',
        segment: action.segment ?? null,
        node: null,
        detail: `${sig} derived ${String(repeats + 1)} times with nothing changing on disk`,
        evidence: [relativeToRoot(options.root, join(options.stateDir, 'journal.jsonl'))],
      });
      const e = escalate(ctx, {
        trigger: TRIGGER.noProgress,
        segment: action.segment ?? null,
        node: null,
        reason: `the run is stuck: \`${sig}\` has been derived ${String(repeats + 1)} times and nothing on disk changed`,
        options: [
          'read .autopilot/journal.jsonl and the newest .autopilot/sessions/*/stdout.log, then fix the cause',
          'take the blocking node manually and resume',
        ],
        evidence: [relativeToRoot(options.root, join(options.stateDir, 'journal.jsonl'))],
      });
      return {
        status: 'ESCALATED',
        iterations: i + 1,
        state: ctx.state,
        lastAction,
        escalation: e,
      };
    }

    if (options.dryRun) {
      deps.log('  (dry run — no worker launched, no command run)');
      return {
        status: 'DRY_RUN',
        iterations: i + 1,
        state: ctx.state,
        lastAction,
        escalation: null,
      };
    }

    const outcome = await step(ctx, action);
    if (outcome.terminal !== null) {
      return {
        status: outcome.terminal,
        iterations: i + 1,
        state: ctx.state,
        lastAction,
        escalation: outcome.escalation ?? null,
      };
    }
  }

  return {
    status: 'ITERATION_LIMIT',
    iterations: options.maxIterations,
    state: ctx.state,
    lastAction,
    escalation: null,
  };
}
