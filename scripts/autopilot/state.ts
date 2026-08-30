/**
 * Durable supervisor state.
 *
 * The single source of truth for **what is done** is the repository: git, the oracle's
 * probes, the gate records under `.artifacts/gates/`, and the lane handoffs under
 * `.artifacts/handoffs/`. `pnpm flow next` reads exactly those and returns the one next
 * action. This file stores none of it.
 *
 * What lives here is the set of facts with no other home — the ones a fresh session cannot
 * re-derive from disk because nothing else records them:
 *
 *   - how many repair attempts a node or a gate has already spent
 *   - which worker session owned which node, and when
 *   - which failures are still unresolved, with the evidence paths that prove them
 *   - a pending escalation and the decision it is waiting for
 *   - the last commit at which every required gate was green
 *
 * That split is deliberate and mirrors `autopilot` §1: where this file and the oracle
 * disagree about completion, the oracle wins and this file is corrected. A supervisor that
 * cached "node X is DONE" would eventually advance a phase on its own memory.
 *
 * Every write is atomic (temp file + rename) and revision-checked. Two supervisors racing is
 * not a supported deployment, but a stale write silently clobbering a newer one is the
 * failure mode that makes a crash unrecoverable, so it is refused rather than trusted.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const STATE_SCHEMA_VERSION = 1;

/** Where a supervised run keeps its control state. Evidence stays in `.artifacts/`. */
export const AUTOPILOT_DIR = '.autopilot';

export type NodeStatus = 'READY' | 'RUNNING' | 'REPAIR' | 'DONE' | 'BLOCKED';

export interface NodeRecord {
  status: NodeStatus;
  /** Worker launches spent on this node, including rotations. */
  launches: number;
  lastWorkerId?: string;
  lastSessionId?: string;
  lastOutcome?: string;
  updatedAt: string;
}

export interface BlockingFailure {
  id: string;
  kind: 'gate' | 'worker' | 'invariant' | 'config' | 'no-progress';
  segment: string | null;
  node: string | null;
  detail: string;
  evidence: string[];
  at: string;
  resolvedAt?: string;
}

export interface Escalation {
  /** The `CLAUDE.md` ## Plan discipline trigger number, 1-6. */
  trigger: number;
  segment: string | null;
  node: string | null;
  reason: string;
  options: string[];
  evidence: string[];
  at: string;
  /** Set by `pnpm autopilot resume` once the human has supplied the missing decision. */
  resolvedAt?: string;
  resolution?: string;
}

export interface SupervisorState {
  schemaVersion: number;
  /** Bumped on every successful write. A write against a stale revision is refused. */
  revision: number;
  runId: string;
  startedAt: string;
  updatedAt: string;
  /** Last action `pnpm flow next` returned. A cache for `status`, never an input to a decision. */
  nextAction: string | null;
  segment: string | null;
  phase: number | null;
  nodes: Record<string, NodeRecord>;
  /** `${segment}::${node ?? 'gate'}` -> materially different repair strategies already spent. */
  repairAttempts: Record<string, number>;
  lastGreenCommit: string | null;
  blockingFailures: BlockingFailure[];
  escalation: Escalation | null;
  /** Mirrors the stop flag file at the moment of the last write. The file is authoritative. */
  stopRequested: boolean;
  /**
   * The two safety bounds this run started under, written before the first worker exists.
   * They are here rather than only in the journal so `pnpm autopilot status` can never show a
   * widened or bypassed run as an ordinary one, and so a run resumed from disk keeps the bound
   * it was authorised for. Optional only because a state file written before this field existed
   * must still load.
   */
  repairBound?: number;
  repairAuthority?: string;
  permissionMode?: string;
  permissionBypassed?: boolean;
}

export class StaleStateError extends Error {
  constructor(
    readonly expected: number,
    readonly found: number,
  ) {
    super(
      `refusing to write supervisor state at revision ${expected}: disk is already at ${found}. ` +
        'Reload and re-apply — a stale write is how a crash becomes unrecoverable.',
    );
    this.name = 'StaleStateError';
  }
}

export function statePath(dir: string): string {
  return join(dir, 'state.json');
}

export function journalPath(dir: string): string {
  return join(dir, 'journal.jsonl');
}

export function initialState(now: Date, runId: string = randomUUID()): SupervisorState {
  const at = now.toISOString();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: 0,
    runId,
    startedAt: at,
    updatedAt: at,
    nextAction: null,
    segment: null,
    phase: null,
    nodes: {},
    repairAttempts: {},
    lastGreenCommit: null,
    blockingFailures: [],
    escalation: null,
    stopRequested: false,
  };
}

/**
 * Read state, or `null` when there is none. A corrupt file is a hard error rather than a
 * silent fresh start: losing the repair counters is exactly how an exhausted repair loop
 * restarts itself forever.
 */
export function readState(dir: string): SupervisorState | null {
  const path = statePath(dir);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    throw new Error(
      `${path} is not valid JSON (${e instanceof Error ? e.message : String(e)}). Fix or delete ` +
        'it deliberately — a supervisor that silently restarts loses its repair bounds.',
    );
  }
  const s = parsed as Partial<SupervisorState>;
  if (s.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(
      `${path} has schemaVersion ${String(s.schemaVersion)}; this supervisor writes ` +
        String(STATE_SCHEMA_VERSION),
    );
  }
  return parsed as SupervisorState;
}

/** Read state, creating and persisting a fresh one when the directory is empty. */
export function loadOrInit(dir: string, now: Date): SupervisorState {
  const existing = readState(dir);
  if (existing) return existing;
  const fresh = initialState(now);
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(dir), `${JSON.stringify(fresh, null, 2)}\n`, 'utf8');
  return fresh;
}

/**
 * Atomic, revision-checked write. Returns the state as persisted, with `revision` bumped —
 * callers must keep the returned object, not the one they passed in.
 */
export function writeState(dir: string, next: SupervisorState, now: Date): SupervisorState {
  mkdirSync(dir, { recursive: true });
  const onDisk = readState(dir);
  if (onDisk && onDisk.revision !== next.revision) {
    throw new StaleStateError(next.revision, onDisk.revision);
  }
  const persisted: SupervisorState = {
    ...next,
    revision: next.revision + 1,
    updatedAt: now.toISOString(),
  };
  const tmp = `${statePath(dir)}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  renameSync(tmp, statePath(dir));
  return persisted;
}

export interface JournalEntry {
  at: string;
  runId: string;
  /** The durable state transition this entry evidences, e.g. `READY -> RUNNING`. */
  transition: string;
  action?: string;
  segment?: string | null;
  node?: string | null;
  outcome?: string;
  /** Artifact paths proving the transition. A transition with no evidence is not one. */
  evidence?: string[];
  detail?: string;
}

/**
 * Append-only run journal. It is the crash-recovery record: `state.json` says where the run
 * is, the journal says how it got there, and neither is rewritten in place.
 */
export function appendJournal(dir: string, entry: JournalEntry): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(journalPath(dir), `${JSON.stringify(entry)}\n`, 'utf8');
}

export function readJournal(dir: string): JournalEntry[] {
  const path = journalPath(dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as JournalEntry];
      } catch {
        return [];
      }
    });
}

export function repairKey(segment: string | null, node: string | null): string {
  return `${segment ?? '-'}::${node ?? 'gate'}`;
}

export function unresolvedFailures(s: SupervisorState): BlockingFailure[] {
  return s.blockingFailures.filter((f) => f.resolvedAt === undefined);
}

/**
 * The unresolved failures that bear on a gate for `segment` — everything except that same
 * gate's own prior hold records.
 *
 * A held gate records a `kind: 'gate'` failure, and that record resolves only when the gate
 * finally records GREEN. Counting it in the gate's own `failureEvidence` source therefore
 * made any once-held gate RED forever: the record could only resolve on the exact GREEN it
 * was blocking, `pnpm autopilot resume` clears only the escalation, and no restart recovers.
 * Proven live on run d9c2177c segment 3 — attempt 1 held on `definitionOfDone` alone,
 * attempt 2 held on `definitionOfDone` plus attempt 1's own hold record.
 *
 * Excluding it loses no signal: every other gate source is re-measured fresh at each
 * attempt, so the re-derivation IS the prior hold's test. Worker, invariant, config and
 * no-progress failures, and other segments' gate failures, still block.
 */
export function failuresBlockingGate(
  s: SupervisorState,
  segment: string | null,
): BlockingFailure[] {
  return unresolvedFailures(s).filter((f) => !(f.kind === 'gate' && f.segment === segment));
}

/** A stop request survives a supervisor crash, so it is a file rather than a signal. */
export function stopFlagPath(dir: string): string {
  return join(dir, 'stop');
}

export function requestStop(dir: string, reason: string, now: Date): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(stopFlagPath(dir), `${now.toISOString()} ${reason}\n`, 'utf8');
}

export function stopRequested(dir: string): boolean {
  return existsSync(stopFlagPath(dir));
}

export function clearStop(dir: string): void {
  rmSync(stopFlagPath(dir), { force: true });
}
