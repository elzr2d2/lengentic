/**
 * LenGentic lane control plane.
 *
 * The oracle answers "what is done and what could start". This answers the next question:
 * **may these units run at the same time, and what proves it afterwards.**
 *
 *   may this batch fan out?     `pnpm lanes decide <id...>`
 *   what is the next wave?      `pnpm lanes wave <phase>`
 *   did the lane stay inside?   `pnpm lanes check <id>`
 *   is this handoff real?       `pnpm lanes handoff <file>`
 *   may this be integrated?     `pnpm lanes integrate <id...>`
 *   how do I isolate them?      `pnpm lanes worktrees <id...>`
 *
 * Three rules shape everything below.
 *
 * **Sequential is the default.** Parallel is an exception a batch has to earn against
 * fifteen hard requirements, every one of which must be verified true. Unknown counts as
 * false — a requirement nobody checked is not a requirement that passed.
 *
 * **Annotation is the opt-in.** A graph node with no `own.allowed` and no `validate` is
 * sequential-only. Inferring a write surface from a lane label would be exactly the guess
 * that puts two Builders in one directory.
 *
 * **This file decides; it never acts.** No merges, no branch deletion, no worktree removal,
 * no commits. `worktrees` prints the commands and stops. A gate that also performs the
 * operation it gates has no failure mode left that a human can catch.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger, evidenceIdFor, type Logger } from './lib/log.ts';
import {
  describeProbe,
  graph,
  loadActivation,
  resolveGraph,
  resolveRoles,
  type ProbeSpec,
  type Resolved,
} from './oracle.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── types ─────────────────────────────────────────────────────────────────────────────

export type Mode = 'sequential' | 'parallel';
export type Risk = 'low' | 'medium' | 'high';

export interface Policy {
  maxConcurrency: number;
  minUnits: number;
  sharedWriteSurfaces: string[];
  serialiseIfTouches: string[];
  alwaysForbidden: string[];
}

/**
 * One candidate work unit, flattened out of the graph (or out of a fixture) into exactly
 * the facts the eligibility gate needs. Nothing here is inferred at evaluation time — if a
 * field is empty it is because the source said nothing, and the gate treats silence as a
 * blocker rather than as a default.
 */
export interface Unit {
  task_id: string;
  title: string;
  lane: string;
  phase: number;
  owner: string;
  risk: Risk | null;
  changeClass: string | null;
  depends_on: string[];
  acceptance_criteria: string[];
  validation_commands: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  /** Dependencies that are neither DONE nor part of this batch. */
  unresolved_deps: string[];
  /** Dependencies that are also in this batch — the thing that makes fan-out unsafe. */
  in_batch_deps: string[];
  /** Dependencies that do not exist in the graph at all. */
  unknown_deps: string[];
  open_decisions: string[];
  /** Whether a bounded packet can be produced for this unit without shipping the plan. */
  has_packet_source: boolean;
}

export interface RepoState {
  isGitRepo: boolean;
  operationInProgress: string | null;
  conflicted: string[];
  dirty: string[];
  head: string | null;
}

export interface Requirement {
  id: string;
  text: string;
  pass: boolean;
  detail: string;
}

export interface LaneEntry {
  task_id: string;
  lane: string;
  risk: Risk | null;
  change_class: string | null;
  allowed_paths: string[];
  forbidden_paths: string[];
  validation: string[];
  required_agents: string[];
  optional_agents: string[];
  /** Batch members that must stop if this one fails. Everything else keeps going. */
  halts_if_failed: string[];
  independent_of: string[];
}

export interface Decision {
  mode: Mode;
  eligible: boolean;
  reasons: string[];
  blockers: string[];
  dependency_order: string[];
  shared_contracts: string[];
  lanes: LaneEntry[];
  max_concurrency: number;
  requirements: Requirement[];
}

// ── path matching ─────────────────────────────────────────────────────────────────────

const GLOB_CHARS = /[*?[\]]/;

export function normalise(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * `**` crosses directory separators, `*` and `?` do not. Everything else is a literal.
 * Deliberately smaller than a real glob library: the patterns in `graph.json` are path
 * prefixes, and a matcher that supports brace expansion invites patterns nobody can reason
 * about at an ownership boundary.
 */
export function matchPath(path: string, pattern: string): boolean {
  const p = normalise(path);
  const src = normalise(pattern)
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === '**/') return '(?:.*/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${src}$`).test(p);
}

/** The literal directory prefix of a pattern — everything before the first glob character. */
export function literalPrefix(pattern: string): string {
  const p = normalise(pattern);
  const i = p.search(GLOB_CHARS);
  if (i === -1) return p;
  const cut = p.slice(0, i);
  const slash = cut.lastIndexOf('/');
  return slash === -1 ? '' : cut.slice(0, slash + 1);
}

/**
 * Conservative pattern intersection: two patterns overlap when one's literal prefix
 * contains the other's.
 *
 * It over-reports — `platform/api/src/a/**` and `platform/api/src/b/**` are called
 * overlapping because both reduce to `platform/api/src/`. That direction is chosen on
 * purpose. A false overlap costs one sequential batch; a missed overlap costs two agents,
 * a conflicted merge, and a reconciliation that a model does badly.
 */
export function patternsOverlap(a: string, b: string): boolean {
  const A = withSlash(literalPrefix(a));
  const B = withSlash(literalPrefix(b));
  return A.startsWith(B) || B.startsWith(A);
}

function withSlash(p: string): string {
  return p === '' || p.endsWith('/') ? p : `${p}/`;
}

export function anyMatch(path: string, patterns: string[]): string | null {
  return patterns.find((pattern) => matchPath(path, pattern)) ?? null;
}

// ── eligibility gate ──────────────────────────────────────────────────────────────────

/**
 * The fifteen hard requirements. Each returns a verdict and the evidence for it, so the
 * decision is auditable rather than a mode string somebody has to trust.
 *
 * Ordering matches the numbered list in `docs/PARALLEL_EXECUTION.md` so a blocker id can be
 * looked up without reading this function.
 */
export function evaluate(units: Unit[], policy: Policy, repo: RepoState): Decision {
  const ids = new Set(units.map((u) => u.task_id));
  const req: Requirement[] = [];
  const add = (id: string, text: string, pass: boolean, detail: string) =>
    req.push({ id, text, pass, detail });

  // R1 — two meaningful work units.
  add(
    'R1',
    'at least two meaningful work units',
    units.length >= Math.max(2, policy.minUnits),
    `${units.length} unit(s); minimum ${Math.max(2, policy.minUnits)}`,
  );

  // R2 / R3 — a unit with no criteria or no commands cannot be judged from outside.
  const noCriteria = units.filter((u) => u.acceptance_criteria.length === 0);
  add(
    'R2',
    'every unit has explicit acceptance criteria',
    noCriteria.length === 0,
    noCriteria.length === 0 ? 'all units declare criteria' : `missing: ${names(noCriteria)}`,
  );

  const noCommands = units.filter((u) => u.validation_commands.length === 0);
  add(
    'R3',
    'every unit has known validation commands',
    noCommands.length === 0,
    noCommands.length === 0
      ? 'all units declare commands'
      : `UNKNOWN validation for: ${names(noCommands)}`,
  );

  // R4 — a dependency the graph does not know about is an unmodelled edge, and unmodelled
  // edges are exactly what fan-out turns into a race.
  const unknownDeps = units.flatMap((u) => u.unknown_deps.map((d) => `${u.task_id}→${d}`));
  add(
    'R4',
    'dependencies between work units are known',
    unknownDeps.length === 0,
    unknownDeps.length === 0 ? 'every edge resolves' : `unmodelled: ${unknownDeps.join(', ')}`,
  );

  // R5 — one unit waiting on another unit's unfinished internals is a sequence wearing a
  // batch's clothes.
  const intra = units.filter((u) => u.in_batch_deps.length > 0);
  add(
    'R5',
    'no lane depends on another lane in this batch',
    intra.length === 0,
    intra.length === 0
      ? 'batch is an antichain'
      : intra.map((u) => `${u.task_id} needs ${u.in_batch_deps.join('+')}`).join('; '),
  );

  // R6 — frozen contracts. An open decision is not a default waiting to be picked.
  const withDecisions = units.filter((u) => u.open_decisions.length > 0);
  const withUnresolved = units.filter((u) => u.unresolved_deps.length > 0);
  add(
    'R6',
    'shared contracts stable and frozen before fan-out',
    withDecisions.length === 0 && withUnresolved.length === 0,
    [
      withDecisions.length > 0
        ? `open decisions: ${withDecisions.map((u) => `${u.task_id}(${u.open_decisions.join(',')})`).join(' ')}`
        : '',
      withUnresolved.length > 0
        ? `unfinished upstream: ${withUnresolved.map((u) => `${u.task_id}←${u.unresolved_deps.join(',')}`).join(' ')}`
        : '',
    ]
      .filter(Boolean)
      .join('; ') || 'no open decisions, every upstream dependency delivered',
  );

  // R7 / R8 — path ownership. Undeclared counts as overlapping everything, because an
  // undeclared surface cannot be proven disjoint from anything.
  const undeclared = units.filter((u) => u.allowed_paths.length === 0);
  const overlaps = pathOverlaps(units);
  add(
    'R7',
    'allowed_paths do not overlap',
    undeclared.length === 0 && overlaps.length === 0,
    [
      undeclared.length > 0 ? `no allowed_paths declared: ${names(undeclared)}` : '',
      overlaps.length > 0 ? overlaps.map((o) => `${o.a} ∩ ${o.b} on ${o.pattern}`).join('; ') : '',
    ]
      .filter(Boolean)
      .join('; ') || 'every declared surface is disjoint',
  );

  const exact = exactCollisions(units);
  add(
    'R8',
    'no two lanes need to modify the same file',
    exact.length === 0,
    exact.length === 0 ? 'no identical declarations' : exact.join('; '),
  );

  // R9 — shared write surfaces. A lockfile or a migration written from two worktrees does
  // not merge; it corrupts, and it corrupts quietly.
  const shared = units.flatMap((u) =>
    u.allowed_paths
      .filter((p) => policy.sharedWriteSurfaces.some((s) => patternsOverlap(p, s)))
      .map((p) => `${u.task_id}:${p}`),
  );
  add(
    'R9',
    'no conflicting migration, lockfile, global config or other shared write surface',
    shared.length === 0,
    shared.length === 0 ? 'no shared write surface claimed' : `claims: ${shared.join(', ')}`,
  );

  // R10 / R11 — validate alone, commit alone, revert alone.
  const notIndependent = units.filter(
    (u) => u.validation_commands.length === 0 || u.allowed_paths.length === 0,
  );
  add(
    'R10',
    'each lane can be validated independently',
    notIndependent.length === 0,
    notIndependent.length === 0
      ? 'each lane has its own commands and its own surface'
      : `cannot be validated alone: ${names(notIndependent)}`,
  );
  add(
    'R11',
    'each lane can be committed and reverted independently',
    shared.length === 0 && overlaps.length === 0 && undeclared.length === 0,
    shared.length === 0 && overlaps.length === 0 && undeclared.length === 0
      ? 'disjoint surfaces, no shared write surface — a revert touches one lane'
      : 'a revert would reach into another lane',
  );

  // R12 — the benefit heuristic, stated as a heuristic. There is no cost model here, and
  // pretending otherwise would be the kind of invented precision this repository forbids.
  const selfContained = units.filter(
    (u) => u.validation_commands.length > 0 && u.acceptance_criteria.length > 0,
  );
  add(
    'R12',
    'estimated benefit exceeds dispatch, review and integration overhead',
    units.length >= Math.max(2, policy.minUnits) && selfContained.length === units.length,
    `${selfContained.length}/${units.length} units are self-contained (criteria + commands). ` +
      'Count heuristic, not a cost model — a self-contained lane needs no round trip, which is where the overhead actually goes.',
  );

  // R13 — the base has to be somewhere a worktree can safely branch from, and no lane may
  // be about to inherit an uncommitted edit inside its own surface.
  const dirtyInLane = repo.dirty.filter((f) =>
    units.some((u) => anyMatch(f, u.allowed_paths) !== null),
  );
  const repoSafe =
    repo.isGitRepo &&
    repo.operationInProgress === null &&
    repo.conflicted.length === 0 &&
    dirtyInLane.length === 0;
  add(
    'R13',
    'repository is in a safe state for isolated worktrees',
    repoSafe,
    [
      repo.isGitRepo ? '' : 'not a git work tree',
      repo.operationInProgress ? `${repo.operationInProgress} in progress` : '',
      repo.conflicted.length > 0 ? `conflicted: ${repo.conflicted.join(', ')}` : '',
      dirtyInLane.length > 0 ? `uncommitted inside a lane surface: ${dirtyInLane.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ') || `clean base at ${repo.head ?? 'HEAD'}`,
  );

  // R14 — bounded context. A unit whose packet cannot be sliced gets handed the plan, and
  // the plan is the largest single line in the token bill.
  const unbounded = units.filter((u) => !u.has_packet_source);
  add(
    'R14',
    'required context fits in a bounded Task Packet',
    unbounded.length === 0,
    unbounded.length === 0
      ? 'every unit has a packet source'
      : `no packet source: ${names(unbounded)}`,
  );

  // R15 — the serialisation veto.
  const highRisk = units.filter((u) => u.risk === 'high');
  const touchesFrozen = units.filter((u) =>
    u.allowed_paths.some((p) => policy.serialiseIfTouches.some((s) => patternsOverlap(p, s))),
  );
  add(
    'R15',
    'no boundary or irreversible-operation risk requires serialisation',
    highRisk.length === 0 && touchesFrozen.length === 0,
    [
      highRisk.length > 0 ? `risk=high: ${names(highRisk)}` : '',
      touchesFrozen.length > 0 ? `edits a frozen contract: ${names(touchesFrozen)}` : '',
    ]
      .filter(Boolean)
      .join('; ') || 'no lane requires serialisation',
  );

  const failed = req.filter((r) => !r.pass);
  const eligible = failed.length === 0;
  const order = dependencyOrder(units);

  return {
    mode: eligible ? 'parallel' : 'sequential',
    eligible,
    reasons: eligible
      ? req.map((r) => `${r.id} ${r.text} — ${r.detail}`)
      : [
          `sequential fallback: ${failed.length} of ${req.length} hard requirements not verified`,
          ...req.filter((r) => r.pass).map((r) => `${r.id} ok — ${r.detail}`),
        ],
    blockers: failed.map((r) => `${r.id} ${r.text} — ${r.detail}`),
    dependency_order: order,
    shared_contracts: sharedContracts(units, ids),
    lanes: units.map((u) => laneEntry(u, units)),
    max_concurrency: eligible ? Math.min(policy.maxConcurrency, units.length) : 1,
    requirements: req,
  };
}

function names(units: Unit[]): string {
  return units.map((u) => u.task_id).join(', ');
}

function pathOverlaps(units: Unit[]): Array<{ a: string; b: string; pattern: string }> {
  const out: Array<{ a: string; b: string; pattern: string }> = [];
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const a = units[i];
      const b = units[j];
      if (!a || !b) continue;
      for (const pa of a.allowed_paths) {
        for (const pb of b.allowed_paths) {
          if (patternsOverlap(pa, pb)) {
            out.push({ a: a.task_id, b: b.task_id, pattern: `${pa} ~ ${pb}` });
          }
        }
      }
    }
  }
  return out;
}

function exactCollisions(units: Unit[]): string[] {
  const byPattern = new Map<string, string[]>();
  for (const u of units) {
    for (const p of u.allowed_paths) {
      byPattern.set(normalise(p), [...(byPattern.get(normalise(p)) ?? []), u.task_id]);
    }
  }
  return [...byPattern.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([p, owners]) => `${owners.join(' + ')} both declare ${p}`);
}

/**
 * Topological order over in-batch edges, ties broken by id so the same batch always
 * integrates in the same order. Integration is sequential whatever the dispatch mode was.
 */
export function dependencyOrder(units: Unit[]): string[] {
  const ids = new Set(units.map((u) => u.task_id));
  const pending = new Map(units.map((u) => [u.task_id, u.depends_on.filter((d) => ids.has(d))]));
  const out: string[] = [];

  while (pending.size > 0) {
    const free = [...pending.entries()]
      .filter(([, deps]) => deps.every((d) => out.includes(d)))
      .map(([id]) => id)
      .sort();
    // A cycle cannot be ordered. Emit the remainder deterministically rather than looping —
    // the caller sees it as a batch it should never have been handed.
    if (free.length === 0) {
      out.push(...[...pending.keys()].sort());
      break;
    }
    for (const id of free) {
      out.push(id);
      pending.delete(id);
    }
  }
  return out;
}

/** Everything two or more units build against but none of them owns. */
function sharedContracts(units: Unit[], batch: Set<string>): string[] {
  const counts = new Map<string, number>();
  for (const u of units) {
    for (const d of u.depends_on) {
      if (batch.has(d)) continue;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([d]) => d)
    .sort();
}

/** Transitive in-batch dependents — the lanes that must stop when this one fails. */
export function dependents(unit: Unit, units: Unit[]): string[] {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const u of units) {
      if (u.task_id === unit.task_id || out.has(u.task_id)) continue;
      if (u.depends_on.some((d) => d === unit.task_id || out.has(d))) {
        out.add(u.task_id);
        grew = true;
      }
    }
  }
  return [...out].sort();
}

function laneEntry(u: Unit, units: Unit[]): LaneEntry {
  const activation = loadActivation();
  const rule = u.changeClass ? activation.classes[u.changeClass] : undefined;
  // A missing or unmapped changeClass used to fall through to an empty required_agents /
  // optional_agents pair — a packet with no validation chain, silently. Hard error instead:
  // ten graph nodes hit exactly this before every one of them was classified.
  if (!rule) {
    throw new Error(
      `unit "${u.task_id}" has no usable changeClass (got ${JSON.stringify(u.changeClass)}) — ` +
        'add one of mechanical|feature|behavior|contract|diagnosis to its graph node so the ' +
        'agent chain is not silently empty',
    );
  }
  const halts = dependents(u, units);
  return {
    task_id: u.task_id,
    lane: u.lane,
    risk: u.risk,
    change_class: u.changeClass,
    allowed_paths: u.allowed_paths,
    forbidden_paths: u.forbidden_paths,
    validation: u.validation_commands,
    required_agents: resolveRoles(rule.required, activation),
    optional_agents: resolveRoles(rule.optional, activation),
    halts_if_failed: halts,
    independent_of: units
      .map((o) => o.task_id)
      .filter((id) => id !== u.task_id && !halts.includes(id))
      .sort(),
  };
}

// ── integration plan ──────────────────────────────────────────────────────────────────

export interface IntegrationStep {
  order: number;
  task_id: string | null;
  gate: 'PRE-INTEGRATION' | 'INTEGRATE' | 'POST-INTEGRATION' | 'BATCH-FINAL';
  commands: string[];
  note: string;
}

/**
 * Integration is sequential in dependency order, and the full suite runs **once**, after
 * the last lane. Running `gates:full` per lane would pay `check:isolation` — a whole
 * install and build in a temp checkout — once per lane to answer a question that only has
 * one answer per batch.
 */
export function integrationPlan(order: string[], units: Unit[]): IntegrationStep[] {
  const byId = new Map(units.map((u) => [u.task_id, u]));
  const steps: IntegrationStep[] = [];
  let n = 1;

  for (const id of order) {
    const u = byId.get(id);
    steps.push({
      order: n,
      task_id: id,
      gate: 'PRE-INTEGRATION',
      commands: [`pnpm lanes handoff .artifacts/handoffs/*-${id}-*.json`, `pnpm lanes check ${id}`],
      note: 'handoff present and valid, commit exists, changed files inside allowed_paths, no collision with already-integrated lanes',
    });
    steps.push({
      order: n,
      task_id: id,
      gate: 'INTEGRATE',
      commands: [`git merge --no-ff lane/${id}`],
      note: 'Integrator only. Merge conflicts are a lane-ownership failure, not a merge problem — stop and re-decide rather than resolving by hand.',
    });
    steps.push({
      order: n,
      task_id: id,
      gate: 'POST-INTEGRATION',
      commands: u?.validation_commands ?? ['pnpm gates'],
      note: "this lane's own commands, re-run against the integrated tree",
    });
    n += 1;
  }

  steps.push({
    order: n,
    task_id: null,
    gate: 'BATCH-FINAL',
    commands: ['pnpm gates:full'],
    note: 'Once, after the whole batch. This is the intended point for the full suite.',
  });
  return steps;
}

// ── graph adapter ─────────────────────────────────────────────────────────────────────

export function policy(): Policy {
  const p = graph.lanePolicy;
  return {
    maxConcurrency: p.maxConcurrency,
    minUnits: p.minUnits,
    sharedWriteSurfaces: p.sharedWriteSurfaces,
    serialiseIfTouches: p.serialiseIfTouches,
    alwaysForbidden: p.alwaysForbidden,
  };
}

export function unitFrom(n: Resolved, byId: Map<string, Resolved>, batch: Set<string>): Unit {
  return {
    task_id: n.id,
    title: n.title,
    lane: n.lane,
    phase: n.phase,
    owner: n.owner,
    risk: n.risk ?? null,
    changeClass: n.changeClass ?? null,
    depends_on: n.needs,
    acceptance_criteria: n.probes.map(describeProbe),
    validation_commands: n.validate ?? [],
    allowed_paths: n.own?.allowed ?? [],
    forbidden_paths: [...(n.own?.forbidden ?? []), ...graph.lanePolicy.alwaysForbidden],
    unknown_deps: n.needs.filter((d) => !byId.has(d)),
    in_batch_deps: n.needs.filter((d) => batch.has(d)),
    unresolved_deps: n.needs.filter(
      (d) => byId.has(d) && !batch.has(d) && byId.get(d)?.state !== 'DONE',
    ),
    open_decisions: graph.decisions
      .filter((d) => !d.answered && d.blocks.includes(n.id))
      .map((d) => d.id),
    has_packet_source: (graph.sections[n.id]?.length ?? 0) > 0,
  };
}

export function unitsFor(ids: string[]): Unit[] {
  const byId = resolveGraph();
  const batch = new Set(ids);
  return ids.map((id) => {
    const n = byId.get(id);
    if (!n) throw new Error(`unknown node: ${id}`);
    return unitFrom(n, byId, batch);
  });
}

// ── repository state ──────────────────────────────────────────────────────────────────

function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  // trimEnd, never trim. `git status --porcelain` is fixed-width: an unstaged modification
  // reports as " M path", and a leading `trim()` eats that space, shifts every column by one
  // and truncates the path — `platform/...` came back as `latform/...` and `pnpm lanes check`
  // BLOCKed a lane that was inside its surface. No caller depends on leading whitespace.
  return { ok: r.status === 0, out: (r.stdout ?? '').trimEnd() };
}

export function repoState(): RepoState {
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) {
    return {
      isGitRepo: false,
      operationInProgress: null,
      conflicted: [],
      dirty: [],
      head: null,
    };
  }
  const gitDir = git(['rev-parse', '--git-dir']);
  const dir = gitDir.ok ? resolve(ROOT, gitDir.out) : join(ROOT, '.git');

  const inProgress = existsSync(join(dir, 'MERGE_HEAD'))
    ? 'merge'
    : existsSync(join(dir, 'rebase-merge')) || existsSync(join(dir, 'rebase-apply'))
      ? 'rebase'
      : existsSync(join(dir, 'CHERRY_PICK_HEAD'))
        ? 'cherry-pick'
        : existsSync(join(dir, 'REVERT_HEAD'))
          ? 'revert'
          : null;

  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  const dirty: string[] = [];
  const conflicted: string[] = [];
  for (const line of status.out.split('\n').filter(Boolean)) {
    const code = line.slice(0, 2);
    const path = normalise(line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop() ?? '');
    if (path === '') continue;
    if (/^(DD|AU|UD|UA|DU|AA|UU)$/.test(code)) conflicted.push(path);
    dirty.push(path);
  }
  const head = git(['rev-parse', '--short', 'HEAD']);
  return {
    isGitRepo: true,
    operationInProgress: inProgress,
    conflicted,
    dirty,
    head: head.ok ? head.out : null,
  };
}

// ── lane ownership gate ───────────────────────────────────────────────────────────────

export interface OwnershipVerdict {
  ok: boolean;
  violations: Array<{ file: string; reason: string; rule: string }>;
  accepted: string[];
}

/**
 * The pre-commit lane gate, as a pure function so the hook, the CLI and the self-test all
 * apply one rule. `forbidden` wins over `allowed`: a path that appears in both is a
 * declaration mistake, and resolving it in the permissive direction defeats the point.
 */
export function checkOwnership(
  changed: string[],
  allowed: string[],
  forbidden: string[],
): OwnershipVerdict {
  const violations: OwnershipVerdict['violations'] = [];
  const accepted: string[] = [];

  for (const raw of changed) {
    const file = normalise(raw);
    // Handoffs and telemetry are how a lane reports; a lane that cannot write its own
    // evidence would have to choose between the gate and the contract.
    if (matchPath(file, '.artifacts/**')) {
      accepted.push(file);
      continue;
    }
    const hitForbidden = anyMatch(file, forbidden);
    if (hitForbidden !== null) {
      violations.push({ file, reason: 'forbidden path', rule: hitForbidden });
      continue;
    }
    if (allowed.length === 0) {
      violations.push({ file, reason: 'lane declares no allowed_paths', rule: '(none)' });
      continue;
    }
    const hitAllowed = anyMatch(file, allowed);
    if (hitAllowed === null) {
      violations.push({ file, reason: 'outside allowed_paths', rule: allowed.join(', ') });
      continue;
    }
    accepted.push(file);
  }
  return { ok: violations.length === 0, violations, accepted };
}

// ── handoff validation ────────────────────────────────────────────────────────────────

export interface HandoffVerdict {
  ok: boolean;
  errors: string[];
  status: string | null;
}

/**
 * Schema shape plus the things a schema cannot see: does the commit exist, did the changed
 * files stay inside the lane, and does the claimed evidence actually bear on the criteria it
 * is offered for. A handoff that claims DONE against a SHA nobody can resolve is the cheapest
 * possible lie and the easiest one to catch; `checkEvidence` below catches the next-cheapest.
 */
export async function validateHandoff(
  handoff: unknown,
  unit: Unit | null,
  opts: { checkCommit: boolean },
): Promise<HandoffVerdict> {
  const errors: string[] = [];
  const schemaPath = join(ROOT, '.claude/rules/lane-handoff.schema.json');
  const libPath = new URL('../.claude/hooks/lib/validate-schema.mjs', import.meta.url).href;

  if (!existsSync(schemaPath)) {
    return { ok: false, errors: [`missing schema: ${schemaPath}`], status: null };
  }
  const lib = (await import(libPath)) as { validate: (v: unknown, s: object) => string[] };
  errors.push(...lib.validate(handoff, JSON.parse(readFileSync(schemaPath, 'utf8'))));

  const h = handoff as Record<string, unknown>;
  const status = typeof h?.status === 'string' ? h.status : null;
  const changed = Array.isArray(h?.changed_files) ? (h.changed_files as string[]) : [];

  if (unit) {
    if (h?.task_id !== unit.task_id) {
      errors.push(
        `task_id "${String(h?.task_id)}" does not match the dispatched unit "${unit.task_id}"`,
      );
    }
    const verdict = checkOwnership(changed, unit.allowed_paths, unit.forbidden_paths);
    for (const v of verdict.violations) {
      errors.push(`changed_files: ${v.file} — ${v.reason} (${v.rule})`);
    }
  }

  errors.push(...checkEvidence(h, status, unit?.acceptance_criteria ?? []));

  if (status === 'DONE' && opts.checkCommit) {
    const sha = typeof h?.commit === 'string' ? h.commit : '';
    if (!git(['cat-file', '-e', `${sha}^{commit}`]).ok) {
      errors.push(`commit "${sha}" does not resolve to a commit in this repository`);
    } else {
      errors.push(...checkChangedFiles(sha, changed));
    }
  }
  return { ok: errors.length === 0, errors, status };
}

/**
 * The commit is the ground truth for what changed; `changed_files` is a self-report next to
 * it. A lane that omits a file escapes the ownership check at handoff time (the file is
 * never compared against `allowed_paths`), and a lane that pads the list claims territory it
 * never touched. Both directions are checkable against `git diff-tree` without trusting the
 * report.
 */
export function checkChangedFiles(sha: string, claimed: string[]): string[] {
  const errors: string[] = [];
  const actual = git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]);
  if (!actual.ok) return errors; // Commit resolution is checked separately; nothing more to say.

  const actualFiles = new Set(actual.out.split('\n').filter(Boolean).map(normalise));
  const claimedFiles = new Set(claimed.map(normalise));

  const omitted = [...actualFiles].filter((f) => !claimedFiles.has(f)).sort();
  const extra = [...claimedFiles].filter((f) => !actualFiles.has(f)).sort();

  if (omitted.length > 0) {
    errors.push(
      `changed_files omits ${omitted.length} file(s) commit "${sha}" actually touched: ${omitted.join(', ')}`,
    );
  }
  if (extra.length > 0) {
    errors.push(
      `changed_files claims ${extra.length} file(s) commit "${sha}" does not touch: ${extra.join(', ')}`,
    );
  }
  return errors;
}

interface RunResult {
  command: string;
  exitCode: number;
  passed: boolean;
}

interface EvidenceItem {
  requirement: string;
  result: string;
  source?: string;
  eventIds?: string[];
  artifact?: string;
}

/** A command that runs tests, so "the suite discovered nothing" becomes a checkable claim. */
const TEST_COMMAND = /(^|\s|:)(test|tests|vitest|jest|playwright|check:integrity)(\s|$|:)/;

/**
 * Everything about whether the claimed evidence supports the claimed status.
 *
 * Exported so `pnpm check:lanes` can drive it directly. The rules are deliberately
 * mechanical: each one is a way a green report can be true about a command and false about
 * the work, and none of them needs an agent's judgement to detect.
 */
export function checkEvidence(
  h: Record<string, unknown>,
  status: string | null,
  packetCriteria: string[] = [],
): string[] {
  const errors: string[] = [];
  const done = status === 'DONE';

  const validation: Record<string, unknown> = isRecord(h.validation) ? h.validation : {};
  const commands = Array.isArray(validation.commands) ? (validation.commands as string[]) : [];
  const results = Array.isArray(validation.results) ? (validation.results as RunResult[]) : [];
  const failures = Array.isArray(h.failures) ? (h.failures as Array<Record<string, unknown>>) : [];
  const risks = Array.isArray(h.risks) ? (h.risks as string[]) : [];
  const artifacts = Array.isArray(h.artifacts) ? (h.artifacts as string[]) : [];
  const evidence = Array.isArray(h.evidence) ? (h.evidence as EvidenceItem[]) : [];
  const criteria: Record<string, unknown> = isRecord(h.acceptance_criteria)
    ? h.acceptance_criteria
    : {};
  const verified = Array.isArray(criteria.verified) ? (criteria.verified as string[]) : [];
  const unverified = Array.isArray(criteria.unverified) ? (criteria.unverified as string[]) : [];

  // 0. Every criterion the packet named lands in exactly one bucket, whatever the status.
  //    A lane that lists 2 of the packet's 5 criteria and verifies both would otherwise
  //    reach DONE with `unverified: []` having said nothing about the other 3 — and a
  //    criterion missing from both buckets triggers no other check below.
  for (const criterion of packetCriteria) {
    const inVerified = verified.includes(criterion);
    const inUnverified = unverified.includes(criterion);
    if (inVerified && inUnverified) {
      errors.push(
        `acceptance_criteria: "${criterion}" appears in both verified and unverified — a criterion lands in exactly one bucket`,
      );
    } else if (!inVerified && !inUnverified) {
      errors.push(
        `acceptance_criteria: packet criterion "${criterion}" appears in neither verified nor unverified — silence is not a bucket`,
      );
    }
  }

  // 1. Results line up with the commands that produced them. A results array the reader
  //    cannot map back to a command is a summary, not evidence.
  if (results.length !== commands.length) {
    errors.push(
      `validation: ${commands.length} command(s) but ${results.length} result(s) — one result per command, same order`,
    );
  }
  results.forEach((r, i) => {
    const expected = commands[i];
    if (expected !== undefined && r?.command !== expected) {
      errors.push(
        `validation.results[${i}]: "${String(r?.command)}" does not match commands[${i}] "${expected}"`,
      );
    }
    // 2. `passed` is the observed exit code, never an expectation.
    if (typeof r?.exitCode === 'number' && r.passed !== (r.exitCode === 0)) {
      errors.push(
        `validation.results[${i}]: passed=${String(r.passed)} contradicts exitCode=${r.exitCode}`,
      );
    }
  });

  // 3. Every failing command is classified. An unclassified failure reads as noise and
  //    gets skimmed past, which is exactly how it survives to the next lane.
  for (const r of results) {
    if (r?.passed !== false) continue;
    const classified = failures.some((f) => f?.command === r.command);
    if (!classified) {
      errors.push(
        `validation: "${String(r.command)}" failed but appears in no failures entry — an unclassified failure`,
      );
    }
    if (done) errors.push(`DONE claimed while "${r.command}" failed`);
  }

  // 4. A rerun that disagrees with itself is flakiness, and flakiness is evidence. A second
  //    green does not erase a first red.
  for (const command of new Set(results.map((r) => r?.command))) {
    const runs = results.filter((r) => r?.command === command);
    if (runs.length < 2 || new Set(runs.map((r) => r.passed)).size < 2) continue;
    if (done) errors.push(`DONE claimed while reruns of "${command}" disagree`);
    const recorded =
      failures.some((f) => f?.command === command) || risks.some((r) => r.includes(command));
    if (!recorded) {
      errors.push(
        `reruns of "${command}" disagree but the flakiness is in neither risks nor failures`,
      );
    }
  }

  // 5. Evidence is per criterion, and only PASS evidence closes one. UNKNOWN is the honest
  //    answer for a check that did not settle its criterion, and it is not a pass.
  const byRequirement = new Map(evidence.map((e) => [e?.requirement, e]));
  for (const e of evidence) {
    if (e?.result === 'PASS') continue;
    if (done) errors.push(`DONE claimed while evidence for "${e?.requirement}" is ${e?.result}`);
  }
  if (done) {
    for (const criterion of verified) {
      const hit = byRequirement.get(criterion);
      if (!hit) {
        errors.push(`acceptance_criteria.verified: "${criterion}" has no matching evidence entry`);
      } else if (hit.result !== 'PASS') {
        errors.push(
          `acceptance_criteria.verified: "${criterion}" is verified but its evidence is ${hit.result}`,
        );
      }
    }
  }

  // 6. A suite that discovered nothing passes perfectly.
  const tests = isRecord(h.tests) ? h.tests : null;
  const ranTests = commands.some((c) => TEST_COMMAND.test(c));
  if (tests) {
    const count = (k: string): number => (typeof tests[k] === 'number' ? (tests[k] as number) : 0);
    const discovered = count('discovered');
    const accounted = count('passed') + count('failed') + count('skipped');
    if (discovered !== accounted) {
      errors.push(
        `tests: discovered ${discovered} but passed+failed+skipped is ${accounted} — ${discovered - accounted} unaccounted`,
      );
    }
    if (done && discovered < 1) errors.push('DONE claimed while zero tests were discovered');
    if (done && count('failed') > 0) {
      errors.push(`DONE claimed while ${count('failed')} test(s) failed`);
    }
  } else if (done && ranTests) {
    errors.push(
      'DONE claimed against a test command with no `tests` counts — report discovered, passed, failed and skipped',
    );
  }

  // 7. A failure whose output is nowhere is a claim.
  if (failures.length > 0 && artifacts.length === 0) {
    errors.push('failures reported with no `artifacts` path holding the captured output');
  }

  // 8. A log is a real evidence source and never a sufficient one. The run that emits the
  //    success line is the same run making the claim, so `source: log` on a PASS is the
  //    claim restated — pair it with a test, command, diff, read-back or trace. And an
  //    eventId with no artifact behind it is a reference nobody can follow.
  for (const e of evidence) {
    if (e?.source === 'log' && e.result === 'PASS') {
      errors.push(
        `evidence for "${e.requirement}" is PASS on a log alone — a self-reported success log is the claim, not the proof`,
      );
    }
    const cited = Array.isArray(e?.eventIds) ? e.eventIds : [];
    if (cited.length > 0 && (e?.artifact ?? '') === '') {
      errors.push(
        `evidence for "${e?.requirement}" cites ${cited.length} log event(s) with no artifact path holding them`,
      );
    }
  }

  return errors;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── telemetry ─────────────────────────────────────────────────────────────────────────

/**
 * Structured, append-only, deduplicated on `batch|task|event`. Reflector reads this instead
 * of re-reading transcripts — measuring coordination overhead by re-parsing the thing whose
 * cost you are measuring is how a retrospective becomes the most expensive step.
 */
export function recordTelemetry(event: Record<string, unknown>): void {
  logGate(event);
  const dest = join(ROOT, '.artifacts/telemetry/lanes.jsonl');
  mkdirSync(dirname(dest), { recursive: true });
  const key = `${String(event.batch_id)}|${String(event.task_id)}|${String(event.event)}`;
  if (existsSync(dest)) {
    const seen = readFileSync(dest, 'utf8')
      .split('\n')
      .filter(Boolean)
      .some((line) => {
        try {
          const e = JSON.parse(line) as Record<string, unknown>;
          return `${String(e.batch_id)}|${String(e.task_id)}|${String(e.event)}` === key;
        } catch {
          return false;
        }
      });
    if (seen) return;
  }
  appendFileSync(dest, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, 'utf8');
}

/**
 * The same gate decision, rendered for a human and recorded as evidence.
 *
 * `lanes.jsonl` above is Reflector's coordination-overhead ledger. This is the run's event
 * log — one line on the console, one record in `.artifacts/telemetry/events.jsonl` that an
 * evidence entry can cite by `eventId`. The two sinks answer different questions, and
 * neither is derived from the other's prose.
 */
let gateLogger: Logger | null = null;

function logGate(event: Record<string, unknown>): void {
  gateLogger ??= createLogger({
    runId: `lanes-${process.pid}`,
    agent: 'lanes',
    artifact: join(ROOT, '.artifacts/telemetry/events.jsonl'),
  });
  const kind = String(event.event);
  const task = typeof event.task_id === 'string' ? event.task_id : String(event.batch_id);
  const scope = { taskId: task, phase: kind };

  if (kind === 'decide') {
    const blockers = Array.isArray(event.blockers) ? (event.blockers as string[]) : [];
    gateLogger.info(
      `decide ${String(event.mode)}${blockers.length > 0 ? ` — blockers ${blockers.join(',')}` : ''}`,
      { ...scope, status: event.eligible === true ? 'completed' : 'blocked' },
    );
    return;
  }

  const ok = kind === 'lane-gate' ? event.ok === true : event.blocked !== true;
  if (ok) {
    gateLogger.pass(`${kind} clean`, {
      ...scope,
      status: 'passed',
      evidenceId: evidenceIdFor(`${kind}:${task}`),
    });
    return;
  }
  gateLogger.error(`${kind} refused`, {
    ...scope,
    status: 'failed',
    failure: {
      errorType: kind,
      expected:
        kind === 'lane-gate'
          ? 'every changed file inside the lane allowed_paths'
          : 'every lane handoff DONE and inside its surface',
      actual:
        kind === 'lane-gate'
          ? `${String(event.violations)} file(s) outside ownership`
          : 'at least one lane failed the pre-integration gate',
    },
  });
}

// ── rendering ─────────────────────────────────────────────────────────────────────────

function yamlList(items: string[], indent: string): string[] {
  return items.length === 0 ? [`${indent}[]`] : items.map((i) => `${indent}- ${quote(i)}`);
}

function quote(s: string): string {
  return /^[A-Za-z0-9._/@-]+$/.test(s) ? s : JSON.stringify(s);
}

export function renderDecision(d: Decision): string {
  const out: string[] = ['execution_decision:'];
  out.push(`  mode: ${d.mode}`);
  out.push(`  eligible: ${d.eligible}`);
  out.push('  reasons:');
  out.push(...yamlList(d.reasons, '    '));
  out.push('  blockers:');
  out.push(...yamlList(d.blockers, '    '));
  out.push('  dependency_order:');
  out.push(...yamlList(d.dependency_order, '    '));
  out.push('  shared_contracts:');
  out.push(...yamlList(d.shared_contracts, '    '));
  out.push('  lanes:');
  if (d.lanes.length === 0) out.push('    []');
  for (const l of d.lanes) {
    out.push(`    - task_id: ${l.task_id}`);
    out.push(`      lane: ${l.lane}`);
    out.push(`      risk: ${l.risk ?? 'null'}`);
    out.push(`      change_class: ${l.change_class ?? 'null'}`);
    out.push('      allowed_paths:');
    out.push(...yamlList(l.allowed_paths, '        '));
    out.push('      forbidden_paths:');
    out.push(...yamlList(l.forbidden_paths, '        '));
    out.push('      validation:');
    out.push(...yamlList(l.validation, '        '));
    out.push(`      required_agents: [${l.required_agents.join(', ')}]`);
    out.push(`      optional_agents: [${l.optional_agents.join(', ')}]`);
    out.push(`      halts_if_failed: [${l.halts_if_failed.join(', ')}]`);
    out.push(`      independent_of: [${l.independent_of.join(', ')}]`);
  }
  out.push(`  max_concurrency: ${d.max_concurrency}`);
  out.push('  requirements:');
  for (const r of d.requirements) {
    out.push(`    - ${r.id}: ${r.pass ? 'PASS' : 'FAIL'}`);
    out.push(`      text: ${quote(r.text)}`);
    out.push(`      detail: ${quote(r.detail)}`);
  }
  return out.join('\n');
}

// ── cli ───────────────────────────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

function positional(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith('--')) {
      if (a !== '--json') i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

export function nextWave(phase: number): string[] {
  const byId = resolveGraph();
  const rows = [...byId.values()].filter(
    (n) => n.phase === phase && n.state !== 'DONE' && n.wave > 0,
  );
  if (rows.length === 0) return [];
  const first = Math.min(...rows.map((n) => n.wave));
  return rows
    .filter((n) => n.wave === first)
    .map((n) => n.id)
    .sort();
}

function isDirectRun(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return resolve(invoked).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'help';
  const rest = argv.slice(1);
  const args = positional(rest);
  const json = rest.includes('--json');

  switch (cmd) {
    case 'decide':
    case 'wave': {
      const ids = cmd === 'wave' ? nextWave(Number(args[0] ?? '0')) : args;
      if (ids.length === 0) {
        console.error(
          cmd === 'wave'
            ? `no outstanding work in phase ${args[0]}`
            : 'usage: pnpm lanes decide <node-id> [<node-id>...]',
        );
        process.exit(1);
      }
      const p = policy();
      const maxOverride = flag(rest, 'max');
      if (maxOverride) p.maxConcurrency = Number(maxOverride);
      const units = unitsFor(ids);
      const decision = evaluate(units, p, repoState());
      const batchId = flag(rest, 'batch') ?? ids.join('+');

      console.log(json ? JSON.stringify(decision, null, 2) : renderDecision(decision));
      if (!json) console.log(`\n${advice(decision, ids)}`);

      recordTelemetry({
        batch_id: batchId,
        task_id: null,
        event: 'decide',
        mode: decision.mode,
        eligible: decision.eligible,
        units: ids,
        blockers: decision.blockers.map((b) => b.split(' ')[0]),
        max_concurrency: decision.max_concurrency,
      });
      break;
    }

    case 'check': {
      const id = args[0];
      if (!id) {
        console.error('usage: pnpm lanes check <node-id> [--base <ref>]');
        process.exit(1);
      }
      const unit = unitsFor([id])[0];
      if (!unit) process.exit(1);
      const base = flag(rest, 'base');
      const changed = changedFiles(base);

      if (changed.length === 0) {
        console.log(`lane ${id}: no changed files against ${base ?? 'HEAD'} — nothing to gate.`);
        break;
      }
      const verdict = checkOwnership(changed, unit.allowed_paths, unit.forbidden_paths);
      console.log(`lane ${id}  —  ${changed.length} changed file(s) against ${base ?? 'HEAD'}`);
      console.log(`  allowed:   ${unit.allowed_paths.join(', ') || '(NONE DECLARED)'}`);
      console.log(`  forbidden: ${unit.forbidden_paths.join(', ')}`);
      console.log('');
      for (const f of verdict.accepted) console.log(`  ok    ${f}`);
      for (const v of verdict.violations) {
        console.error(`  BLOCK ${v.file}  — ${v.reason} [${v.rule}]`);
      }
      recordTelemetry({
        batch_id: flag(rest, 'batch') ?? id,
        task_id: id,
        event: 'lane-gate',
        ok: verdict.ok,
        changed: changed.length,
        violations: verdict.violations.length,
      });
      if (!verdict.ok) {
        console.error(
          `\nlane ${id} FAILED its pre-commit gate: ${verdict.violations.length} file(s) outside ownership.`,
        );
        process.exit(1);
      }
      console.log(`\nlane ${id} stayed inside its declared surface.`);
      break;
    }

    case 'handoff': {
      const file = args[0];
      if (!file) {
        console.error('usage: pnpm lanes handoff <file.json> [--task <node-id>]');
        process.exit(1);
      }
      if (!existsSync(file)) {
        console.error(`no such handoff file: ${file}`);
        process.exit(1);
      }
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const taskId =
        flag(rest, 'task') ??
        (typeof (parsed as Record<string, unknown>)?.task_id === 'string'
          ? String((parsed as Record<string, unknown>).task_id)
          : undefined);
      const unit =
        taskId && graph.nodes.some((n) => n.id === taskId) ? unitsFor([taskId])[0] : null;
      const verdict = await validateHandoff(parsed, unit ?? null, { checkCommit: true });

      if (verdict.ok) {
        console.log(`${file}: valid lane handoff, status ${verdict.status}`);
        break;
      }
      console.error(`${file} is not a valid lane handoff:`);
      for (const e of verdict.errors) console.error(`  - ${e}`);
      console.error(
        '\nA handoff that does not validate is not a DONE lane. Skipped, deferred and' +
          '\nunknown checks all belong in acceptance_criteria.unverified.',
      );
      process.exit(1);
      break;
    }

    case 'integrate': {
      if (args.length === 0) {
        console.error('usage: pnpm lanes integrate <node-id> [<node-id>...]');
        process.exit(1);
      }
      const units = unitsFor(args);
      const order = dependencyOrder(units);
      const steps = integrationPlan(order, units);
      let failures = 0;
      let integrated: string[] = [];

      console.log(`Integration order: ${order.join(' → ')}\n`);
      for (const id of order) {
        const unit = units.find((u) => u.task_id === id);
        if (!unit) continue;
        const path = handoffPath(unit);
        if (!existsSync(path)) {
          console.error(`  BLOCK ${id}  — no handoff at ${path}`);
          failures += 1;
          break;
        }
        const verdict = await validateHandoff(
          JSON.parse(readFileSync(path, 'utf8')) as unknown,
          unit,
          { checkCommit: true },
        );
        if (!verdict.ok || verdict.status !== 'DONE') {
          console.error(`  BLOCK ${id}  — handoff status ${verdict.status ?? 'invalid'}`);
          for (const e of verdict.errors) console.error(`          ${e}`);
          failures += 1;
          break; // Integration stops on the first failure; §6 forbids integrating past evidence.
        }
        const clash = integrated.filter((prev) => {
          const p = units.find((u) => u.task_id === prev);
          return p?.allowed_paths.some((a) =>
            unit.allowed_paths.some((b) => patternsOverlap(a, b)),
          );
        });
        if (clash.length > 0) {
          console.error(
            `  BLOCK ${id}  — path collision with already-integrated ${clash.join(', ')}`,
          );
          failures += 1;
          break;
        }
        console.log(`  ok    ${id}  — handoff DONE, ownership clean`);
        integrated = [...integrated, id];
      }

      console.log('\nPlan:\n');
      for (const s of steps) {
        console.log(
          `  ${String(s.order).padStart(2)}  ${s.gate.padEnd(16)} ${s.task_id ?? '(batch)'}`,
        );
        for (const c of s.commands) console.log(`      $ ${c}`);
      }
      recordTelemetry({
        batch_id: flag(rest, 'batch') ?? args.join('+'),
        task_id: null,
        event: 'integration-gate',
        order,
        blocked: failures > 0,
        integrated,
      });
      if (failures > 0) {
        console.error('\nPre-integration gate failed. Nothing above the failure was integrated.');
        process.exit(1);
      }
      break;
    }

    case 'worktrees': {
      if (args.length === 0) {
        console.error('usage: pnpm lanes worktrees <node-id> [<node-id>...]');
        process.exit(1);
      }
      const units = unitsFor(args);
      const state = repoState();
      console.log('# Isolation setup. Review and run these yourself — this command never');
      console.log('# executes git, and never removes a worktree or a branch.');
      console.log(`# base: ${state.head ?? 'UNKNOWN'}\n`);
      const baseDatabaseUrl = readBaseDatabaseUrl();
      for (const u of units) {
        const laneSlug = slug(u.task_id);
        console.log(`# ${u.task_id} — ${u.title}`);
        console.log(`git worktree add -b lane/${u.task_id} ../lengentic-lane-${laneSlug} HEAD`);
        console.log(
          `node -e "require('fs').mkdirSync('../lengentic-lane-${laneSlug}/.artifacts/lanes',{recursive:true})"`,
        );
        console.log(`# then write ../lengentic-lane-${laneSlug}/.artifacts/lanes/current.json:`);
        console.log(
          `#   ${JSON.stringify({ task_id: u.task_id, allowed_paths: u.allowed_paths, forbidden_paths: u.forbidden_paths })}`,
        );
        if (baseDatabaseUrl) {
          const laneUrl = laneDatabaseUrl(baseDatabaseUrl, laneSlug);
          console.log(
            `# R9 — isolated Postgres schema so this lane and any sibling lane never share`,
          );
          console.log(`# a write surface on the same database instance:`);
          console.log(
            `node -e "const fs=require('fs');const e=fs.readFileSync('.env','utf8').replace(/^DATABASE_URL=.*$/m,'DATABASE_URL=${laneUrl}');fs.writeFileSync('../lengentic-lane-${laneSlug}/.env',e)"`,
          );
          console.log(
            `# then, inside the worktree, run the lane's migrate command once (e.g. \`pnpm --filter database db:migrate\`)`,
          );
          console.log(
            `# — Prisma creates the '${laneSchemaName(laneSlug)}' schema on first migrate.`,
          );
        } else {
          console.log(
            `# WARNING: no DATABASE_URL found in ${join(ROOT, '.env')} — this lane will share`,
          );
          console.log(
            `# the default schema with every other worktree unless you set one manually.`,
          );
        }
        console.log('');
      }
      console.log('# Cleanup is deliberately not scripted. Removing a worktree discards');
      console.log('# uncommitted lane work, and that is a human decision.');
      break;
    }

    case 'probes': {
      const report = lintProbes();
      for (const line of report.failures) console.error(`FAIL  ${line}`);
      for (const line of report.warnings) console.log(`WARN  ${line}`);
      if (report.failures.length > 0) {
        console.error(
          `\ncheck:probes failed — ${report.failures.length} probe(s) can be satisfied by work` +
            ' their own node does not own.\nA probe that passes reads exactly like work that is' +
            ' done. Narrow the probe to a path only this\nnode can create.',
        );
        process.exit(1);
      }
      console.log(
        `\ncheck:probes passed — ${report.checked} probe target(s) across ${report.nodes} node(s).` +
          ' WARN hits are prompts to look, not verdicts.',
      );
      break;
    }

    case 'selftest': {
      const mod = (await import('./lanes/selftest.ts')) as { run: () => Promise<number> };
      process.exit(await mod.run());
      break;
    }

    default:
      console.error(
        'usage: pnpm lanes <command>\n' +
          '  decide <id...> [--json] [--max n] [--batch name]  eligibility gate\n' +
          '  wave <phase>   [--json]                           decide over the next wave\n' +
          '  check <id>     [--base ref]                       pre-commit lane gate\n' +
          '  handoff <file> [--task id]                        lane handoff validation\n' +
          '  integrate <id...>                                 pre-integration gate + plan\n' +
          '  worktrees <id...>                                 isolation commands (prints only)\n' +
          '  probes                                            probe hygiene: can a node lie\n' +
          '  selftest                                          workflow scenarios',
      );
      process.exit(1);
  }
}

function slug(id: string): string {
  return id.replace(/[^a-zA-Z0-9]+/g, '-');
}

/** Reads the current DATABASE_URL out of the repo-root `.env`, if one exists. */
function readBaseDatabaseUrl(): string | undefined {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return undefined;
  const match = readFileSync(envPath, 'utf8').match(/^DATABASE_URL=(.*)$/m);
  return match?.[1]?.trim();
}

/** Postgres schema name for a lane — same instance, isolated write surface (R9). */
function laneSchemaName(laneSlug: string): string {
  return `lane_${laneSlug.replace(/-/g, '_')}`;
}

/** Rewrites a DATABASE_URL's `schema` query param to this lane's own schema. */
function laneDatabaseUrl(baseUrl: string, laneSlug: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('schema', laneSchemaName(laneSlug));
  return url.toString();
}

// ── probe hygiene ─────────────────────────────────────────────────────────────────────
//
// A probe records what is on disk; the oracle turns that into DONE. So a probe that another
// node's deliverable can satisfy is a node that reports DONE before it starts, and the
// failure is silent — a probe that passes reads exactly like work that is done.
//
// It happened. `p5.det-candidate` probed `grep minorityContextConcentration` over the whole
// of `platform/analysis-engine`, and `p5.repeated-failed` probed `inputFingerprint` over the
// same directory. Wave 1 graduated the types, `src/types.ts` and `src/tool-call.ts` carried
// both strings, and from the moment wave 1 merged the oracle dropped both analyzer packets
// out of `waves` entirely and `pnpm lanes wave 5` batched two 5b packets in their place.
//
// One rule closes it: **a probe may only look inside the surface its own node owns.** The
// broken probes named `platform/analysis-engine`, which is not inside `src/**` or
// `test/analyzer/**`, so they were free to match another packet's output.

interface ProbeTarget {
  /** Repository-relative path the probe reads. */
  path: string;
  /** How it is described in a failure line. */
  label: string;
  /** Evidence files answer to `.artifacts/**`, not to the node's write surface. */
  evidence?: boolean;
}

/**
 * The paths a probe reads. `script` names a package script and `cmd` is its own evidence, so
 * neither has a surface to check.
 */
function probeTargets(p: ProbeSpec): ProbeTarget[] {
  switch (p.kind) {
    case 'path':
    case 'absent':
      return [{ path: p.path, label: `${p.kind} ${p.path}` }];
    case 'grep': {
      // `runProbe` joins file onto dir, so dir is only a search root when file is present.
      // Checking both would fail every `dir: "."` probe that names a real file.
      const target = p.file ? `${p.dir}/${p.file}` : p.dir;
      return [{ path: normalise(target), label: `grep ${target}` }];
    }
    case 'manual':
      return [{ path: p.evidence, label: `manual ${p.evidence}`, evidence: true }];
    default:
      return [];
  }
}

/**
 * A directory target is inside `dir/**` even though the glob wants something after the
 * slash, so try the trailing-slash form too. Without this every directory probe reads as a
 * violation of its own surface.
 */
function insideSurface(target: string, patterns: string[]): boolean {
  return anyMatch(target, patterns) !== null || anyMatch(`${target}/`, patterns) !== null;
}

export function lintProbes(): {
  failures: string[];
  warnings: string[];
  checked: number;
  nodes: number;
} {
  const failures: string[] = [];
  const warnings: string[] = [];
  let checked = 0;

  const nodes = [...resolveGraph().values()];
  for (const n of nodes) {
    const allowed = n.own?.allowed ?? [];
    let strong = false;

    for (const p of n.probes) {
      if (p.kind === 'path' || p.kind === 'absent') strong = true;

      for (const t of probeTargets(p)) {
        checked += 1;

        if (t.evidence) {
          if (!insideSurface(normalise(t.path), ['.artifacts/**'])) {
            failures.push(
              `${n.id}  ${t.label}  evidence must live under .artifacts/, so a human can find it`,
            );
          }
          continue;
        }

        if (allowed.length === 0) {
          warnings.push(
            `${n.id}  ${t.label}  node declares no own.allowed, so its probe surface cannot be checked`,
          );
          continue;
        }

        if (!insideSurface(normalise(t.path), allowed)) {
          failures.push(
            `${n.id}  ${t.label}  is outside its own surface [${allowed.join(', ')}]` +
              ' — another node can satisfy it',
          );
        }
      }
    }

    // Grep alone is satisfied by any file containing a string. It is the weakest evidence the
    // probe vocabulary can express, and it is the shape both broken probes had.
    if (n.probes.length > 0 && !strong) {
      warnings.push(`${n.id}  has no path or absent probe — grep alone is weak evidence`);
    }
  }

  return { failures, warnings, checked, nodes: nodes.length };
}

function handoffPath(u: Unit): string {
  return join(ROOT, `.artifacts/handoffs/${u.phase}-${u.task_id}-${u.owner}.json`);
}

function changedFiles(base: string | undefined): string[] {
  const files = new Set<string>();
  const state = repoState();
  for (const f of state.dirty) files.add(f);
  if (base) {
    const diff = git(['diff', '--name-only', `${base}...HEAD`]);
    for (const f of diff.out.split('\n').filter(Boolean)) files.add(normalise(f));
  }
  return [...files].sort();
}

function advice(d: Decision, ids: string[]): string {
  if (d.eligible) {
    return [
      `PARALLEL approved for ${ids.length} lanes at concurrency ${d.max_concurrency}.`,
      `Next: pnpm lanes worktrees ${ids.join(' ')}`,
      `Then dispatch one packet per lane in a single message: ${ids.map((i) => `pnpm oracle packet ${i}`).join(' ; ')}`,
    ].join('\n');
  }
  return [
    `SEQUENTIAL. ${d.blockers.length} hard requirement(s) not verified.`,
    `Run them in this order: ${d.dependency_order.join(' → ')}`,
    `Start with: pnpm oracle packet ${d.dependency_order[0] ?? ids[0] ?? ''}`,
  ].join('\n');
}

if (isDirectRun()) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
