/**
 * Structured logging with two outputs, and one rule holding them together: the console line
 * is a summary of a JSONL record, never a second source of truth.
 *
 * `CLAUDE.md`: detail lives in artifacts and the report carries the path. A log obeys the
 * same rule. The console gets phase starts, state transitions, gate results, retries,
 * blockers and the final summary — the things a human scans for. Everything, including the
 * `DEBUG` the console hides, lands in the JSONL artifact, which is what an evidence entry
 * cites through `eventIds`.
 *
 * Three guards are enforced here rather than described:
 *
 *   - `PASS` requires an `evidenceId`. A zero exit code is not one. Success is logged after
 *     the gate that proves it, not after the process that ran it.
 *   - `ERROR` and `FATAL` require a `failure` block carrying `expected` and `actual`. A
 *     failure line nobody can act on costs the same to write as one they can.
 *   - `summary()` is derived from the recorded events. There is no hand-written summary to
 *     disagree with them.
 *
 * A log is evidence about what was observed. It is never, on its own, evidence that the
 * work is correct — see `.claude/skills/structured-logging/SKILL.md`.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

// ── levels and colour ─────────────────────────────────────────────────────────────────

export type Level = 'DEBUG' | 'INFO' | 'PASS' | 'WARN' | 'ERROR' | 'FATAL';

export const LEVELS: readonly Level[] = ['DEBUG', 'INFO', 'PASS', 'WARN', 'ERROR', 'FATAL'];

/** Console threshold ordering. `PASS` sits with `INFO`: a gate result is normal progress. */
const RANK: Record<Level, number> = {
  DEBUG: 0,
  INFO: 1,
  PASS: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4,
};

const ANSI: Record<Level, string> = {
  DEBUG: '\u001b[90m',
  INFO: '\u001b[36m',
  PASS: '\u001b[32m',
  WARN: '\u001b[33m',
  ERROR: '\u001b[31m',
  FATAL: '\u001b[91m',
};

const RESET = '\u001b[0m';

/**
 * Colour is a property of the destination, not of the message. Anything that is not an
 * interactive terminal — a pipe, a file, a CI log, a JSONL sink — gets plain text, because
 * an escape sequence in a captured artifact is corruption a reader has to strip later.
 */
export function colorsEnabled(
  env: Record<string, string | undefined>,
  stream: { isTTY?: boolean },
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') {
    return true;
  }
  if (env.CI !== undefined && env.CI !== '') return false;
  return stream.isTTY === true;
}

// ── the event ─────────────────────────────────────────────────────────────────────────

export type EventStatus =
  'started' | 'completed' | 'passed' | 'failed' | 'blocked' | 'retry' | 'skipped' | 'unknown';

export const STATUSES: readonly EventStatus[] = [
  'started',
  'completed',
  'passed',
  'failed',
  'blocked',
  'retry',
  'skipped',
  'unknown',
];

export interface FailureDetail {
  errorType: string;
  expected: string;
  actual: string;
  command?: string;
  exitCode?: number;
  retryCount?: number;
  classification?: string;
  stackArtifact?: string;
  stdoutArtifact?: string;
  stderrArtifact?: string;
}

export interface TestCounts {
  discovered: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface LogEvent {
  timestamp: string;
  level: Level;
  eventId: string;
  runId: string;
  message: string;
  taskId?: string;
  laneId?: string;
  agent?: string;
  phase?: string;
  status?: EventStatus;
  attempt?: number;
  durationMs?: number;
  evidenceId?: string;
  artifact?: string;
  tests?: TestCounts;
  failure?: FailureDetail;
  /**
   * The event this one repeats or propagates. A retry cites the failure it retries and a
   * caller re-reporting a callee's error cites the original, so the same stack is written
   * once and referenced everywhere else.
   */
  duplicateOf?: string;
}

/** What a caller supplies. `timestamp`, `eventId` and `runId` are the logger's to fill. */
export type EventInput = Omit<LogEvent, 'timestamp' | 'eventId' | 'runId'> &
  Partial<Pick<LogEvent, 'eventId' | 'runId'>>;

// ── redaction and bounds ──────────────────────────────────────────────────────────────

/**
 * Whole words, not substrings. A key called `passed` is a test count, and a redactor that
 * cannot tell it from `password` corrupts the evidence it was added to protect.
 */
const SECRET_WORDS = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'secrets',
  'token',
  'authorization',
  'auth',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'session',
  'bearer',
]);

/** Two-word names that only read as a secret once the separator is dropped. */
const SECRET_COMPOUNDS = ['apikey', 'privatekey', 'accesskey', 'secretkey', 'authtoken'];

export function isSecretKey(key: string): boolean {
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+|\s+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
  if (parts.some((p) => SECRET_WORDS.has(p))) return true;
  const joined = parts.join('');
  return SECRET_COMPOUNDS.some((w) => joined.includes(w));
}

const SECRET_VALUE = [
  /\b(sk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(postgres|postgresql|mysql|mongodb):\/\/[^:\s]+:[^@\s]+@/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

export const REDACTED = '[REDACTED]';

/** Bounded so one runaway string cannot make an artifact unreadable. */
const MAX_STRING = 2000;

function truncate(value: string): string {
  if (value.length <= MAX_STRING) return value;
  const cut = value.length - MAX_STRING;
  return `${value.slice(0, MAX_STRING)}…[truncated ${cut} chars — full output belongs in an artifact]`;
}

function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE) out = out.replace(pattern, REDACTED);
  return truncate(out);
}

/**
 * Redaction is applied on the way into both sinks, so no path exists by which a secret is
 * written to disk and scrubbed from the console only.
 */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = isSecretKey(key) ? REDACTED : redact(inner);
    }
    return out;
  }
  return value;
}

// ── identity ──────────────────────────────────────────────────────────────────────────

/**
 * Stable across runs and across agents: the same failure, reported twice, carries the same
 * id, which is what makes deduplication and "this retry is that failure" mechanical rather
 * than a matter of reading two messages and deciding they look alike.
 */
export function eventId(e: {
  runId?: string;
  agent?: string;
  phase?: string;
  taskId?: string;
  level: Level;
  message: string;
}): string {
  const key = [
    e.runId ?? '',
    e.agent ?? '',
    e.phase ?? '',
    e.taskId ?? '',
    e.level,
    e.message,
  ].join('|');
  return `ev_${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

export function evidenceIdFor(requirement: string): string {
  return `EV-${createHash('sha256').update(requirement).digest('hex').slice(0, 8)}`;
}

// ── invariants ────────────────────────────────────────────────────────────────────────

/**
 * What a log line may not claim. These are the shapes that turn a log into a false witness,
 * so they throw rather than warn: a logger that degrades quietly produces exactly the
 * confident, wrong record it exists to prevent.
 */
export function checkEvent(e: LogEvent): string[] {
  const errors: string[] = [];

  if (!LEVELS.includes(e.level)) {
    errors.push(`level "${String(e.level)}" is outside ${LEVELS.join(' | ')}`);
  }
  if (e.status !== undefined && !STATUSES.includes(e.status)) {
    errors.push(`status "${String(e.status)}" is outside ${STATUSES.join(' | ')}`);
  }
  if (e.message.trim() === '') errors.push('message must not be empty');

  if (e.level === 'PASS' && (e.evidenceId ?? '') === '') {
    errors.push('PASS requires an evidenceId — a zero exit code is not evidence of a passed gate');
  }
  if (e.level === 'ERROR' || e.level === 'FATAL') {
    const f = e.failure;
    if (!f) {
      errors.push(`${e.level} requires a failure block with errorType, expected and actual`);
    } else {
      if ((f.errorType ?? '') === '') errors.push('failure.errorType must not be empty');
      if ((f.expected ?? '') === '') errors.push('failure.expected must not be empty');
      if ((f.actual ?? '') === '') errors.push('failure.actual must not be empty');
    }
  }
  if (e.tests) {
    const accounted = e.tests.passed + e.tests.failed + e.tests.skipped;
    if (e.tests.discovered !== accounted) {
      errors.push(
        `tests: discovered ${e.tests.discovered} but passed+failed+skipped is ${accounted}`,
      );
    }
  }
  return errors;
}

// ── rendering ─────────────────────────────────────────────────────────────────────────

function clockOf(timestamp: string): string {
  return timestamp.slice(11, 19);
}

/**
 * `12:41:26 ERROR [tester/task-2] RBAC mismatch · 1.2s · evidence=EV-014`
 *
 * One line, scannable down the left edge. The detail the line omits is in the JSONL record
 * with the same `eventId`.
 */
export function formatConsole(e: LogEvent, color: boolean): string {
  const scope = [e.agent, e.taskId ?? e.laneId].filter(Boolean).join('/');
  const parts: string[] = [];
  if (scope !== '') parts.push(`[${scope}]`);
  parts.push(e.message);
  if (typeof e.durationMs === 'number') parts.push(`${(e.durationMs / 1000).toFixed(1)}s`);
  if (e.evidenceId !== undefined) parts.push(`evidence=${e.evidenceId}`);
  if (e.artifact !== undefined) parts.push(e.artifact);

  const head = `${clockOf(e.timestamp)} ${e.level.padEnd(5)}`;
  const body = `${parts[0] ?? ''}${parts.length > 1 ? ` ${parts.slice(1).join(' · ')}` : ''}`;
  return color ? `${ANSI[e.level]}${head}${RESET} ${body}` : `${head} ${body}`;
}

// ── summary ───────────────────────────────────────────────────────────────────────────

export interface Summary {
  phases_completed: number;
  phases_failed: number;
  gates_passed: number;
  gates_failed: number;
  tests_passed: number;
  tests_failed: number;
  tests_skipped: number;
  retries: number;
  unknowns: number;
  evidence_artifact: string;
  verdict: 'DONE' | 'BLOCKED';
}

/**
 * Derived, never asserted. `verdict` is `DONE` only when nothing failed and nothing is
 * unknown — an unknown is not a pass, here as everywhere else in this repository.
 */
export function summarize(events: readonly LogEvent[], evidenceArtifact: string): Summary {
  const phases = (status: EventStatus): number =>
    new Set(events.filter((e) => e.status === status && e.phase !== undefined).map((e) => e.phase))
      .size;

  const totals = events.reduce(
    (acc, e) => {
      if (!e.tests) return acc;
      return {
        passed: acc.passed + e.tests.passed,
        failed: acc.failed + e.tests.failed,
        skipped: acc.skipped + e.tests.skipped,
      };
    },
    { passed: 0, failed: 0, skipped: 0 },
  );

  const gatesFailed = events.filter((e) => e.level === 'ERROR' || e.level === 'FATAL').length;
  const unknowns = events.filter((e) => e.status === 'unknown').length;
  const phasesFailed = phases('failed');

  return {
    phases_completed: phases('completed'),
    phases_failed: phasesFailed,
    gates_passed: events.filter((e) => e.level === 'PASS').length,
    gates_failed: gatesFailed,
    tests_passed: totals.passed,
    tests_failed: totals.failed,
    tests_skipped: totals.skipped,
    retries: events.filter((e) => e.status === 'retry').length,
    unknowns,
    evidence_artifact: evidenceArtifact,
    verdict:
      gatesFailed === 0 && phasesFailed === 0 && unknowns === 0 && totals.failed === 0
        ? 'DONE'
        : 'BLOCKED',
  };
}

/** Where a reader checks that a reported summary is the one its events support. */
export function summaryDisagreements(
  events: readonly LogEvent[],
  claimed: Summary,
  evidenceArtifact: string,
): string[] {
  const derived = summarize(events, evidenceArtifact);
  return (Object.keys(derived) as Array<keyof Summary>)
    .filter((k) => derived[k] !== claimed[k])
    .map((k) => `summary.${k}: claimed ${String(claimed[k])}, events say ${String(derived[k])}`);
}

// ── the logger ────────────────────────────────────────────────────────────────────────

export interface LoggerOptions {
  runId: string;
  /** Console threshold. `DEBUG` noise is hidden by default; the artifact keeps it. */
  level?: Level;
  agent?: string;
  phase?: string;
  taskId?: string;
  /** JSONL destination. Pass an empty string to record in memory only. */
  artifact?: string;
  stream?: { write: (chunk: string) => unknown; isTTY?: boolean };
  env?: Record<string, string | undefined>;
  /** Injected so a test asserts on a fixed clock rather than on a moving one. */
  clock?: () => string;
}

export interface Logger {
  event: (input: EventInput) => LogEvent;
  debug: (message: string, fields?: Partial<EventInput>) => LogEvent;
  info: (message: string, fields?: Partial<EventInput>) => LogEvent;
  pass: (message: string, fields: Partial<EventInput> & { evidenceId: string }) => LogEvent;
  warn: (message: string, fields?: Partial<EventInput>) => LogEvent;
  error: (message: string, fields: Partial<EventInput> & { failure: FailureDetail }) => LogEvent;
  events: () => readonly LogEvent[];
  summary: () => Summary;
  /** Emits the derived summary as its own `INFO` record and returns it. */
  finish: () => Summary;
}

export const DEFAULT_ARTIFACT = '.artifacts/telemetry/events.jsonl';

export function createLogger(options: LoggerOptions): Logger {
  const {
    runId,
    level = 'INFO',
    artifact = DEFAULT_ARTIFACT,
    stream = process.stdout,
    env = process.env,
    clock = () => new Date().toISOString(),
  } = options;

  const color = colorsEnabled(env, stream);
  const recorded: LogEvent[] = [];
  const seen = new Set<string>();

  const write = (e: LogEvent, duplicate: boolean): void => {
    // The artifact keeps every event, including the ones the console threshold hides — it
    // is the evidence sink, and evidence filtered at write time cannot be recovered.
    if (artifact !== '') {
      const dest = artifact;
      mkdirSync(dirname(dest), { recursive: true });
      appendFileSync(dest, `${JSON.stringify(e)}\n`, 'utf8');
    }
    // A repeat is written as a reference and never re-rendered. The console shows the
    // failure once; a second copy reads as a second failure.
    if (duplicate) return;
    if (RANK[e.level] < RANK[level]) return;
    stream.write(`${formatConsole(e, color)}\n`);
  };

  const emit = (input: EventInput): LogEvent => {
    // `exactOptionalPropertyTypes`: an absent field stays absent rather than becoming an
    // explicit `undefined`, so the JSONL record has no null-shaped keys to interpret.
    const agent = input.agent ?? options.agent;
    const phase = input.phase ?? options.phase;
    const taskId = input.taskId ?? options.taskId;
    const inherited: Partial<LogEvent> = {};
    if (agent !== undefined) inherited.agent = agent;
    if (phase !== undefined) inherited.phase = phase;
    if (taskId !== undefined) inherited.taskId = taskId;

    const base: LogEvent = {
      ...input,
      ...inherited,
      timestamp: clock(),
      runId: input.runId ?? runId,
      eventId: '',
    };
    const clean = redact(base) as LogEvent;
    const id = input.eventId ?? eventId(clean);
    const event: LogEvent = { ...clean, eventId: id };

    const errors = checkEvent(event);
    if (errors.length > 0) {
      throw new Error(`refusing to log an unsound event: ${errors.join('; ')}`);
    }

    const duplicate = seen.has(id);
    if (duplicate) {
      const reference: LogEvent = {
        timestamp: event.timestamp,
        level: 'DEBUG',
        eventId: `${id}#repeat`,
        runId: event.runId,
        message: `repeat of ${id}`,
        duplicateOf: id,
      };
      recorded.push(reference);
      write(reference, true);
      return event;
    }

    seen.add(id);
    recorded.push(event);
    write(event, false);
    return event;
  };

  const at =
    (lvl: Level) =>
    (message: string, fields: Partial<EventInput> = {}): LogEvent =>
      emit({ ...fields, level: lvl, message });

  return {
    event: emit,
    debug: at('DEBUG'),
    info: at('INFO'),
    pass: at('PASS'),
    warn: at('WARN'),
    error: at('ERROR'),
    events: () => recorded,
    summary: () => summarize(recorded, artifact),
    finish: () => {
      const s = summarize(recorded, artifact);
      emit({
        level: s.verdict === 'DONE' ? 'INFO' : 'WARN',
        message: `summary verdict=${s.verdict} gates ${s.gates_passed} passed / ${s.gates_failed} failed · tests ${s.tests_passed}/${s.tests_failed}/${s.tests_skipped} · retries ${s.retries} · unknowns ${s.unknowns}`,
        artifact,
      });
      return s;
    },
  };
}
