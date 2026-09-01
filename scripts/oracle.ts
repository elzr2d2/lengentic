/**
 * LenGentic delivery oracle.
 *
 * Answers four questions about the MVP, mechanically:
 *
 *   what is actually done?          `pnpm oracle status`
 *   what can start right now?       `pnpm oracle ready`
 *   what can run in parallel?       `pnpm oracle waves [phase]`
 *   what is the whole picture?      `pnpm oracle matrix` / `pnpm oracle md`
 *
 * Status is PROBED from the repository, never read from a checkbox. CLAUDE.md: mechanical
 * checks are tooling, not agents. A plan checkbox records what someone believed at the time
 * they typed it; a probe records what is on disk now. When they disagree, the probe wins.
 *
 * Probes are deliberately shallow — path exists, symbol present, script declared. A probe
 * is a cheap presence signal, not a correctness proof. Correctness is `pnpm gates`. The
 * oracle tells you WHERE you are so you can decide WHAT to dispatch; it does not tell you
 * the code is right.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type ProbeSpec =
  | { kind: 'path'; path: string }
  | { kind: 'absent'; path: string }
  | { kind: 'script'; name: string }
  | { kind: 'grep'; dir: string; file?: string; pattern: string }
  | { kind: 'cmd'; run: string }
  | { kind: 'manual'; evidence: string };

export type Risk = 'low' | 'medium' | 'high';
export type ChangeClass = 'mechanical' | 'feature' | 'behavior' | 'contract' | 'diagnosis';

export interface Ownership {
  allowed: string[];
  forbidden?: string[];
}

export interface LanePolicy {
  maxConcurrency: number;
  minUnits: number;
  sharedWriteSurfaces: string[];
  serialiseIfTouches: string[];
  alwaysForbidden: string[];
  lanes: Record<string, Ownership>;
}

export interface Node {
  id: string;
  phase: number;
  lane: string;
  title: string;
  owner: string;
  needs: string[];
  probes: ProbeSpec[];
  note?: string;
  optional?: boolean;
  /** Declared write surface. Its ABSENCE is what makes a node ineligible for parallel dispatch. */
  own?: Ownership;
  /** Verified commands that decide this deliverable. Absent means "unknown", not "pnpm gates". */
  validate?: string[];
  risk?: Risk;
  changeClass?: ChangeClass;
}

export interface Decision {
  id: string;
  question: string;
  answered: boolean;
  blocks: string[];
  neededBy: string;
}

export interface Graph {
  planRef: string;
  /** Segment ids in delivery order — plain phase numbers plus split segments like "5a". */
  executionOrder?: string[];
  /** For a split phase: segment id → the node ids it owns. */
  segments?: Record<string, string[]>;
  /**
   * For a split phase: segment id → the plan's numbered sections it owns (top-level numbers;
   * `20` covers `20.1`). Authored with the split; `pnpm check:kb` fails until it is complete.
   */
  segmentSections?: Record<string, string[]>;
  lanePolicy: LanePolicy;
  decisions: Decision[];
  sections: Record<string, string[]>;
  nodes: Node[];
}

export type State = 'DONE' | 'PARTIAL' | 'TODO';
export type Readiness = 'READY' | 'BLOCKED' | 'DONE' | 'IN-PROGRESS';

export interface Resolved extends Node {
  state: State;
  hits: number;
  blockedBy: string[];
  readiness: Readiness;
  depth: number;
  wave: number;
}

const GRAPH_PATH = join(ROOT, 'scripts/oracle/graph.json');

/**
 * The delivery graph, as it is on disk NOW.
 *
 * This used to be `export const graph = JSON.parse(readFileSync(...))` — read once, at module
 * load. `resolveGraph()` re-ran the probes on every call, so the answer looked live, but the
 * probe DEFINITIONS came from that frozen snapshot. In a one-shot CLI nothing can go wrong. In
 * a long-lived process it goes wrong silently and in the worst direction: the autopilot
 * supervisor imports `flow.ts` once and calls `nextAction()` once per iteration, so a worker
 * that narrows a false-green probe and commits it changes nothing the supervisor can see, for
 * the rest of the run. Not hypothetical — the Phase 4 wave gate spent two gate workers and a
 * repair worker on exactly this, each correctly reporting from its own fresh process that no
 * gate was owed while the supervisor kept re-deriving WAVE_GATE from probes that no longer
 * existed on disk.
 *
 * Re-read rather than cached on mtime: a cache keyed on anything but the bytes is a smaller
 * version of the same bug, and parsing ~66 KB is nothing beside the filesystem walk every
 * `grep` probe already does.
 */
export function loadGraph(): Graph {
  return JSON.parse(readFileSync(GRAPH_PATH, 'utf8')) as Graph;
}

// ── probes ────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'generated', 'coverage']);

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function runProbe(p: ProbeSpec): boolean {
  switch (p.kind) {
    case 'path':
      return existsSync(join(ROOT, p.path));

    case 'absent':
      return !existsSync(join(ROOT, p.path));

    case 'script': {
      const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      return Boolean(pkg.scripts?.[p.name]);
    }

    case 'grep': {
      const re = new RegExp(p.pattern);
      const target = p.file ? join(ROOT, p.dir, p.file) : join(ROOT, p.dir);
      if (!existsSync(target)) return false;
      const files = statSync(target).isDirectory() ? walk(target) : [target];
      return files.some((f) => {
        try {
          return re.test(readFileSync(f, 'utf8'));
        } catch {
          return false;
        }
      });
    }

    case 'cmd': {
      const r = spawnSync(p.run, { stdio: 'ignore', timeout: 5000, shell: true });
      return r.status === 0;
    }

    // Manual probes need an evidence file a human or Validator drops after a real run.
    // No evidence file means not verified — never "probably fine".
    case 'manual':
      return existsSync(join(ROOT, p.evidence));
  }
}

// ── resolution ────────────────────────────────────────────────────────────────────────

export function resolveGraph(): Map<string, Resolved> {
  const graph = loadGraph();
  const byId = new Map<string, Resolved>();
  const unansweredBlocks = new Map<string, string[]>();

  for (const d of graph.decisions) {
    if (d.answered) continue;
    for (const target of d.blocks) {
      unansweredBlocks.set(target, [...(unansweredBlocks.get(target) ?? []), d.id]);
    }
  }

  for (const n of graph.nodes) {
    const hits = n.probes.filter(runProbe).length;
    const state: State = hits === n.probes.length ? 'DONE' : hits > 0 ? 'PARTIAL' : 'TODO';
    byId.set(n.id, {
      ...n,
      hits,
      state,
      blockedBy: [],
      readiness: 'BLOCKED',
      depth: 0,
      wave: 0,
    });
  }

  // Depth = longest dependency chain. Wave = the parallel batch a node belongs to within
  // its phase: everything at the same wave has no dependency on anything else at that wave.
  const depthOf = (id: string, seen = new Set<string>()): number => {
    const n = byId.get(id);
    if (!n || seen.has(id)) return 0;
    seen.add(id);
    if (n.needs.length === 0) return 0;
    return 1 + Math.max(...n.needs.map((d) => depthOf(d, new Set(seen))));
  };

  for (const n of byId.values()) {
    n.depth = depthOf(n.id);

    const missingDeps = n.needs.filter((d) => byId.get(d)?.state !== 'DONE');
    const openDecisions = unansweredBlocks.get(n.id) ?? [];
    n.blockedBy = [...missingDeps, ...openDecisions];

    if (n.state === 'DONE') n.readiness = 'DONE';
    else if (n.state === 'PARTIAL') n.readiness = 'IN-PROGRESS';
    else n.readiness = n.blockedBy.length === 0 ? 'READY' : 'BLOCKED';
  }

  // Wave is computed per phase over unfinished work only, so a phase already half-built
  // does not report waves that were consumed months ago.
  for (const phase of new Set([...byId.values()].map((n) => n.phase))) {
    const inPhase = [...byId.values()].filter((n) => n.phase === phase);
    let wave = 1;
    const placed = new Set<string>();
    let remaining = inPhase.filter((n) => n.state !== 'DONE');
    while (remaining.length > 0 && wave < 20) {
      const batch = remaining.filter((n) =>
        n.needs.every((d) => {
          const dep = byId.get(d);
          if (!dep) return true;
          return dep.state === 'DONE' || placed.has(d) || dep.phase !== phase;
        }),
      );
      if (batch.length === 0) break;
      for (const n of batch) {
        n.wave = wave;
        placed.add(n.id);
      }
      remaining = remaining.filter((n) => !placed.has(n.id));
      wave += 1;
    }
  }

  return byId;
}

// ── rendering ─────────────────────────────────────────────────────────────────────────

const MARK: Record<Readiness, string> = {
  DONE: 'DONE       ',
  'IN-PROGRESS': 'IN-PROGRESS',
  READY: 'READY      ',
  BLOCKED: 'BLOCKED    ',
};

function phaseRows(byId: Map<string, Resolved>, phase: number): Resolved[] {
  return [...byId.values()]
    .filter((n) => n.phase === phase)
    .sort((a, b) => a.wave - b.wave || a.id.localeCompare(b.id));
}

function phases(byId: Map<string, Resolved>): number[] {
  return [...new Set([...byId.values()].map((n) => n.phase))].sort((a, b) => a - b);
}

function summary(byId: Map<string, Resolved>): string {
  const lines: string[] = [];
  for (const phase of phases(byId)) {
    const rows = phaseRows(byId, phase).filter((n) => !n.optional);
    const done = rows.filter((n) => n.state === 'DONE').length;
    const bar = '#'.repeat(Math.round((done / rows.length) * 20)).padEnd(20, '.');
    const ready = rows.filter((n) => n.readiness === 'READY').length;
    lines.push(
      `  Phase ${phase}  [${bar}] ${String(done).padStart(2)}/${String(rows.length).padEnd(2)}` +
        `  ready:${ready}  maxParallel:${maxParallel(byId, phase)}`,
    );
  }
  return lines.join('\n');
}

function maxParallel(byId: Map<string, Resolved>, phase: number): number {
  const rows = phaseRows(byId, phase).filter((n) => n.state !== 'DONE' && n.wave > 0);
  if (rows.length === 0) return 0;
  const counts = new Map<number, number>();
  for (const n of rows) counts.set(n.wave, (counts.get(n.wave) ?? 0) + 1);
  return Math.max(...counts.values());
}

function matrix(byId: Map<string, Resolved>): string {
  const out: string[] = [];
  for (const phase of phases(byId)) {
    out.push(`\nPHASE ${phase}`);
    out.push('  wave  status       lane         id                       blocked by');
    out.push('  ' + '-'.repeat(96));
    for (const n of phaseRows(byId, phase)) {
      const wave = n.state === 'DONE' ? '  - ' : ` w${n.wave} `;
      const blocked = n.blockedBy.length > 0 ? n.blockedBy.join(', ') : '';
      out.push(
        `  ${wave} ${MARK[n.readiness]}  ${n.lane.padEnd(11)}  ${n.id.padEnd(23)}  ${blocked}`,
      );
    }
  }
  return out.join('\n');
}

function ready(byId: Map<string, Resolved>): string {
  const rows = [...byId.values()]
    .filter((n) => n.readiness === 'READY' || n.readiness === 'IN-PROGRESS')
    .sort((a, b) => a.phase - b.phase || a.depth - b.depth);
  if (rows.length === 0)
    return '  nothing unblocked — resolve open decisions or finish in-flight work';
  return rows
    .map(
      (n) =>
        `  [P${n.phase} ${n.lane.padEnd(11)}] ${n.readiness === 'IN-PROGRESS' ? '~' : '+'} ${n.id.padEnd(23)} ${n.title}` +
        (n.owner !== 'builder' ? `  (owner: ${n.owner})` : ''),
    )
    .join('\n');
}

function waves(byId: Map<string, Resolved>, phase: number): string {
  const rows = phaseRows(byId, phase).filter((n) => n.state !== 'DONE');
  if (rows.length === 0) return `  Phase ${phase} has no outstanding work.`;
  const out: string[] = [];
  const maxWave = Math.max(...rows.map((n) => n.wave));
  for (let w = 1; w <= maxWave; w += 1) {
    const batch = rows.filter((n) => n.wave === w);
    if (batch.length === 0) continue;
    out.push(`\n  WAVE ${w}  —  ${batch.length} agent${batch.length > 1 ? 's in parallel' : ''}`);
    for (const n of batch) {
      out.push(`    ${n.owner.padEnd(9)} ${n.id.padEnd(23)} ${n.title}`);
      if (n.note) out.push(`              note: ${n.note}`);
    }
  }
  const clashes = collisions(byId, phase);
  if (clashes.length > 0) {
    out.push('', '  LANE COLLISIONS — same wave, same directory. Isolate or serialise these:');
    for (const [w, lane, ids] of clashes) {
      out.push(`    wave ${w}  lane ${lane}  ${ids.join(' + ')}`);
    }
  }
  return out.join('\n');
}

// ── contract slicing ──────────────────────────────────────────────────────────────────

/**
 * Pull one numbered section (or one PHASE block) out of the plan, from its heading to the
 * next heading at the same or higher level. Subsections come along with their parent —
 * asking for §20 gets §20.1 and §20.2, which is what a Builder implementing the analyzers
 * actually needs.
 */
function sliceSection(plan: string, id: string): string | null {
  const lines = plan.split('\n');
  const escaped = id.replace(/\./g, '\\.');
  const open = id.startsWith('PHASE')
    ? new RegExp(`^(#+) ${escaped}\\b`)
    : new RegExp(`^(#+) ${escaped}\\. `);

  const start = lines.findIndex((l) => open.test(l));
  if (start === -1) return null;

  const level = (lines[start]?.match(/^#+/)?.[0] ?? '#').length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const depth = lines[i]?.match(/^(#+) /)?.[1]?.length;
    if (depth !== undefined && depth <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

/**
 * The ownership half of a work packet. A packet that names a deliverable but not a write
 * surface is how two lanes end up editing the same file: neither agent was ever told where
 * its edge was, so neither could have stopped.
 *
 * Absence is reported as absence. An unannotated node prints "NOT DECLARED" and says the
 * node is sequential-only — it does not silently inherit the lane default, because a lane
 * default is a category and a Builder needs a boundary.
 */
function ownershipBlock(n: Resolved): string[] {
  const policy = loadGraph().lanePolicy;
  const declared = n.own?.allowed ?? [];
  const forbidden = [...(n.own?.forbidden ?? []), ...policy.alwaysForbidden];

  const out = ['## Path ownership', ''];

  if (declared.length === 0) {
    out.push(
      '`allowed_paths`: **NOT DECLARED** — this node carries no `own.allowed` in',
      '`scripts/oracle/graph.json`. It is sequential-only: `pnpm lanes decide` refuses to',
      'dispatch it beside another lane. Write inside the lane default below and nowhere else,',
      `and expect a human to widen the declaration before this node is parallelised.`,
      '',
      `Lane default for \`${n.lane}\`: ${fmtPaths(policy.lanes[n.lane]?.allowed ?? [])}`,
    );
  } else {
    out.push(`**allowed_paths** — write here and nowhere else:`, '', ...bullets(declared));
  }

  out.push(
    '',
    '**forbidden_paths** — an edit here fails the lane gate, whatever the task seems to need:',
    '',
    ...bullets(forbidden),
    '',
    'Verify before you commit:',
    '',
    '```bash',
    `pnpm lanes check ${n.id}`,
    '```',
    '',
  );
  return out;
}

/**
 * The per-packet agent chain for one node: the class lifecycle's `perPacket` bucket, plus
 * `architecture` when the node is a contract gated by an open decision — the one activation
 * condition a script can check. A settled contract does not pay for an Architect dispatch.
 */
export function perPacketCaps(
  changeClass: string,
  openDecisions: number,
  activation: Activation,
): string[] {
  const rule = lifecycleOf(changeClass, activation);
  if (!rule) return [];
  const caps = [...rule.perPacket];
  if (
    changeClass === 'contract' &&
    openDecisions > 0 &&
    rule.conditional.includes('architecture') &&
    !caps.includes('architecture')
  ) {
    caps.unshift('architecture');
  }
  return caps;
}

/** Validation, acceptance and the agents this change class actually needs. */
export function verificationBlock(n: Resolved): string[] {
  const commands = n.validate ?? [];
  const activation = loadActivation();
  const cls = n.changeClass;
  const rule = cls ? lifecycleOf(cls, activation) : null;
  // A missing or unmapped changeClass used to silently drop the whole `## Agents` block — a
  // packet with no validation chain, and nothing in the output said so. Hard error instead.
  if (!rule || !cls) {
    throw new Error(
      `node "${n.id}" has no usable changeClass (got ${JSON.stringify(cls)}) — add one of ` +
        'mechanical|feature|behavior|contract|diagnosis to scripts/oracle/graph.json so the ' +
        'agent chain is not silently empty',
    );
  }

  const out = ['## Validation', ''];
  if (commands.length === 0) {
    out.push(
      '`validation.commands`: **UNKNOWN** — no `validate` array on this node. Run `pnpm gates`',
      'and say in your handoff that the node declared no specific commands. Do not invent one',
      'and do not report an unrun command as passed.',
      '',
    );
  } else {
    out.push('```bash', ...commands, '```', '');
  }

  out.push(
    '## Acceptance criteria',
    '',
    'Each line is verified or it goes in `acceptance_criteria.unverified`. There is no third',
    'bucket — deferred, skipped and unknown all read as unverified.',
    '',
    ...n.probes.map((p) => `- ${describeProbe(p)}`),
    ...(n.note ? [`- ${n.note}`] : []),
    '',
    `Probe presence is not correctness. ${commands.length > 0 ? 'The commands above are' : '`pnpm gates` is'} the real gate.`,
    '',
  );

  const openDecisions = loadGraph().decisions.filter((d) => !d.answered && d.blocks.includes(n.id));
  const packetCaps = perPacketCaps(cls, openDecisions.length, activation);
  const cadence: Record<string, string> = {
    'per-node':
      'per node — this class is inherited downstream; review lands before the next lane builds on it',
    wave: "wave gate — one review over the wave's combined diff, never per node",
    phase: "phase gate — one review over the phase's combined diff, never per node or per wave",
    none: 'none unless explicitly triggered',
  };
  out.push(
    '## Agents',
    '',
    `Change class **${cls}** (risk ${n.risk ?? 'unstated'}): ${rule.rationale}`,
    '',
    `- per packet: ${resolveRoles(packetCaps, activation).join(' → ') || 'none'}`,
    `- at the wave gate: ${resolveRoles(rule.perWave, activation).join(', ') || 'none'}`,
    `- at the phase gate: ${resolveRoles(rule.perPhase, activation).join(', ') || 'none'}`,
    `- conditional: ${resolveRoles(rule.conditional, activation).join(', ') || 'none'}`,
    `- review cadence: ${cadence[reviewLifecycle(cls, activation)]}`,
    '',
    'Conditional agents run when their activation condition in',
    '`.claude/rules/agent-activation.json` fires, not by default. Dispatching an agent that',
    'had nothing to look at costs the same as one that did. Deterministic commands are run',
    'directly — Runner is dispatched only for long, noisy or repeated output.',
    '',
  );
  return out;
}

function bullets(items: string[]): string[] {
  return items.length === 0 ? ['- (none)'] : items.map((i) => `- \`${i}\``);
}

function fmtPaths(paths: string[]): string {
  return paths.length === 0 ? '(none)' : paths.map((p) => `\`${p}\``).join(', ');
}

export interface ClassLifecycle {
  perPacket: string[];
  perWave: string[];
  perPhase: string[];
  conditional: string[];
  rationale: string;
}

export interface Activation {
  capabilities: Record<string, string[]>;
  classes: Record<string, ClassLifecycle>;
  activationConditions?: Record<string, string[]>;
  responsibilities?: Record<string, string[]>;
  controlPlane?: Record<string, string>;
}

/**
 * The lifecycle for one change class, with every bucket normalised to an array. A class the
 * file does not know returns null — callers hard-error on that, because an unmapped class
 * silently shipping an empty agent chain is exactly the bug this used to have.
 */
export function lifecycleOf(changeClass: string, activation: Activation): ClassLifecycle | null {
  const rule = activation.classes[changeClass];
  if (!rule) return null;
  return {
    perPacket: rule.perPacket ?? [],
    perWave: rule.perWave ?? [],
    perPhase: rule.perPhase ?? [],
    conditional: rule.conditional ?? [],
    rationale: rule.rationale,
  };
}

export type ReviewLifecycle = 'per-node' | 'wave' | 'phase' | 'none';

/**
 * Review cadence is DERIVED from where `review` sits in the class lifecycle — one source of
 * truth instead of a class chain and a cadence block that can disagree.
 */
export function reviewLifecycle(changeClass: string, activation: Activation): ReviewLifecycle {
  const rule = lifecycleOf(changeClass, activation);
  if (!rule) return 'none';
  if (rule.perPacket.includes('review')) return 'per-node';
  if (rule.perWave.includes('review')) return 'wave';
  if (rule.perPhase.includes('review')) return 'phase';
  return 'none';
}

/** Whether this change class keeps its per-node review; everything else reviews later. */
export function reviewIsPerNode(changeClass: string, activation: Activation): boolean {
  return reviewLifecycle(changeClass, activation) === 'per-node';
}

let activationCache: Activation | null = null;

/**
 * Agent activation is a rules file, not a prompt. Capabilities are resolved to whichever
 * agent file actually exists, so the harness works whether execution is owned by a merged
 * `validator` or by a separate `runner`/`tester` pair — without two definitions of who owns
 * running the tests.
 */
export function loadActivation(): Activation {
  if (activationCache) return activationCache;
  activationCache = JSON.parse(
    readFileSync(join(ROOT, '.claude/rules/agent-activation.json'), 'utf8'),
  ) as Activation;
  return activationCache;
}

export function resolveRoles(capabilities: string[], activation: Activation): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const cap of capabilities) {
    const candidates = activation.capabilities[cap] ?? [cap];
    const agent = candidates.find((a) => existsSync(join(ROOT, `.claude/agents/${a}.md`)));
    const name = agent ?? `${cap} (NO AGENT FILE)`;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** A ready-to-dispatch work packet: role, scope, the exact contract, and the exit test. */
function packet(byId: Map<string, Resolved>, id: string): string {
  const n = byId.get(id);
  if (!n) throw new Error(`unknown node: ${id}`);

  const graph = loadGraph();
  const plan = readFileSync(join(ROOT, graph.planRef), 'utf8');
  const wanted = graph.sections[id] ?? [];
  const slices = wanted.map((s) => sliceSection(plan, s)).filter((s): s is string => s !== null);

  const openDecisions = graph.decisions.filter((d) => !d.answered && d.blocks.includes(id));

  const out: Array<string | null> = [
    `# Work packet — ${n.id}`,
    '',
    `**Deliverable:** ${n.title}`,
    `**Phase:** ${n.phase}   **Lane:** ${n.lane}   **Owner:** ${n.owner}   **Wave:** ${n.wave}`,
    '',
    '## Scope',
    '',
    'Implement exactly this deliverable. Anything else valuable goes to `BACKLOG.md` — do not',
    'expand the phase, do not start adjacent deliverables, do not redesign the plan.',
    '',
    n.note ? `**Note on this deliverable:** ${n.note}\n` : null,
    // Naming the state matters. A packet that says "already delivered" about something that
    // is not on disk sends a Builder importing a module that does not exist.
    n.needs.length > 0
      ? `**Depends on:** ${n.needs.map((d) => `${d} (${byId.get(d)?.state ?? 'UNKNOWN'})`).join(', ')}\n`
      : null,
    '',
  ];

  if (openDecisions.length > 0) {
    out.push(
      '## STOP — unanswered decisions gate this packet',
      '',
      ...openDecisions.map((d) => `- **${d.id}** — ${d.question}`),
      '',
      'Do not pick a default. Report BLOCKED and name the decision.',
      '',
    );
  }

  out.push(
    '## Binding contract',
    '',
    `Sliced verbatim from \`${graph.planRef}\`. This is the whole contract for this packet —`,
    'you do not need to read the rest of the plan, and reading it costs tokens without',
    'adding constraint.',
    '',
    '---',
    '',
    slices.join('\n\n---\n\n'),
    '',
    '---',
    '',
    '## Standing rules',
    '',
    '- `platform/shared/schema/**` is the only wire contract. Prisma types never cross a',
    '  module boundary.',
    '- Boundaries are enforced by `pnpm check:boundaries`, not by you. Do not hand-audit imports.',
    '- Recommendations are hypotheses with counterevidence. Say "attested success rate".',
    '',
    ...ownershipBlock(n),
    ...verificationBlock(n),
    '## Stop conditions',
    '',
    '- Work outside `allowed_paths` turns out to be required → stop, report `BLOCKED`, name',
    '  the path. Do not widen your own boundary.',
    '- An unanswered decision gates the work → stop, report `BLOCKED`, name the decision.',
    '- Two repair attempts have failed → stop, report `BLOCKED` with both attempts. A third',
    '  guess costs more than a handoff.',
    '- The contract above turns out to be wrong → stop. Redesigning the approved plan while',
    '  implementing it is out of scope for every lane.',
    '',
    '## Handoff',
    '',
    'Write `.artifacts/handoffs/' + n.phase + '-' + n.id + '-' + n.owner + '.json` matching',
    '`.claude/rules/lane-handoff.schema.json`, then verify it:',
    '',
    '```bash',
    `pnpm lanes handoff .artifacts/handoffs/${n.phase}-${n.id}-${n.owner}.json`,
    '```',
    '',
    '`DONE` requires a commit SHA, changed files inside `allowed_paths`, and every acceptance',
    'criterion in `verified`. Unclear cause is `BLOCKED`, not `FAILED`; an unevidenced failure',
    'is an opinion.',
  );

  return out.filter((l) => l !== null).join('\n');
}

export function describeProbe(p: ProbeSpec): string {
  switch (p.kind) {
    case 'path':
      return `\`${p.path}\` exists`;
    case 'absent':
      return `\`${p.path}\` is gone`;
    case 'script':
      return `root script \`${p.name}\` exists`;
    case 'grep':
      return `/${p.pattern}/ appears under \`${p.file ?? p.dir}\``;
    case 'cmd':
      return `\`${p.run}\` exits 0`;
    case 'manual':
      return `evidence file \`${p.evidence}\` exists`;
  }
}

// ── collision detection ───────────────────────────────────────────────────────────────

/**
 * Two agents in the same wave and the same lane will edit the same directory. That is a
 * merge conflict waiting to happen, and conflicts are the most expensive failure mode in
 * parallel dispatch — you pay for both agents and then pay again to reconcile them.
 */
function collisions(byId: Map<string, Resolved>, phase: number): Array<[number, string, string[]]> {
  const rows = phaseRows(byId, phase).filter((n) => n.state !== 'DONE' && n.wave > 0);
  const seen = new Map<string, string[]>();
  for (const n of rows) {
    const key = `${n.wave}|${n.lane}`;
    seen.set(key, [...(seen.get(key) ?? []), n.id]);
  }
  return [...seen.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => {
      const [w, lane] = key.split('|');
      return [Number(w), lane, ids] as [number, string, string[]];
    });
}

// ── leverage ──────────────────────────────────────────────────────────────────────────

/**
 * Walk a blocked node's `blockedBy` chain down to its root causes — the things a human can
 * actually act on today. A root cause is an unanswered decision, an environment gap, or a
 * node that is already READY and just needs dispatching. Everything between is bookkeeping:
 * "blocked by p2.ingest-endpoint" is not an action, it is a restatement.
 */
function rootCauses(
  byId: Map<string, Resolved>,
  id: string,
  seen = new Set<string>(),
): Set<string> {
  const roots = new Set<string>();
  if (seen.has(id)) return roots;
  seen.add(id);

  const n = byId.get(id);
  if (!n) {
    roots.add(id); // a decision id — terminal by definition
    return roots;
  }
  if (n.readiness === 'READY' || n.readiness === 'IN-PROGRESS') {
    roots.add(id);
    return roots;
  }
  for (const b of n.blockedBy) {
    for (const r of rootCauses(byId, b, seen)) roots.add(r);
  }
  return roots;
}

/**
 * Rank every actionable root by how much it unblocks. This is the difference between a
 * to-do list and a plan: forty blocked nodes usually trace to three or four real causes,
 * and the ordering tells you which conversation to have first.
 */
function unblock(byId: Map<string, Resolved>): string {
  const blocked = [...byId.values()].filter((n) => n.readiness === 'BLOCKED');
  const leverage = new Map<string, Set<string>>();

  for (const n of blocked) {
    for (const root of rootCauses(byId, n.id)) {
      const set = leverage.get(root) ?? new Set<string>();
      set.add(n.id);
      leverage.set(root, set);
    }
  }

  const ranked = [...leverage.entries()].sort((a, b) => b[1].size - a[1].size);
  const out: string[] = [
    `  ${blocked.length} deliverables are blocked. They trace to ${ranked.length} root causes.`,
    '',
  ];

  for (const [root, gated] of ranked) {
    const node = byId.get(root);
    const decision = loadGraph().decisions.find((d) => d.id === root);

    const label = node
      ? `${node.owner === 'human' ? 'ENV     ' : 'DISPATCH'}  ${root}`
      : `DECIDE    ${root}`;
    const what = node ? node.title : (decision?.question ?? root);

    out.push(`  ${label.padEnd(34)} unblocks ${String(gated.size).padStart(2)}`);
    out.push(`    ${what}`);
    if (node?.note) out.push(`    note: ${node.note}`);
    out.push(`    gates: ${[...gated].sort().join(', ')}`);
    out.push('');
  }

  return out.join('\n');
}

function decisions(): string {
  const open = loadGraph().decisions.filter((d) => !d.answered);
  if (open.length === 0) return '  all open decisions answered';
  return open
    .map(
      (d) =>
        `  ${d.id}  (needed by ${d.neededBy})  ${d.question}\n        blocks: ${d.blocks.join(', ')}`,
    )
    .join('\n');
}

function markdown(byId: Map<string, Resolved>): string {
  const graph = loadGraph();
  const md: string[] = [
    '# LenGentic — Project Status Matrix',
    '',
    `Generated by \`pnpm oracle md\` from \`scripts/oracle/graph.json\` against ${graph.planRef}.`,
    'Every status below is probed from the repository. Do not hand-edit this file.',
    '',
    '## Phase progress',
    '',
    '```text',
    summary(byId),
    '```',
    '',
    '## Open decisions',
    '',
    '```text',
    decisions(),
    '```',
    '',
    '## Root causes, ranked by leverage',
    '',
    '```text',
    unblock(byId),
    '```',
    '',
    '## Deliverable matrix',
    '',
    '| Phase | Wave | Status | Lane | Deliverable | Owner | Blocked by |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const phase of phases(byId)) {
    for (const n of phaseRows(byId, phase)) {
      md.push(
        `| ${phase} | ${n.state === 'DONE' ? '—' : n.wave} | ${n.readiness} | ${n.lane} | \`${n.id}\` — ${n.title} | ${n.owner} | ${n.blockedBy.join(', ') || '—'} |`,
      );
    }
  }
  md.push('', '## Parallel waves per phase', '');
  for (const phase of phases(byId)) {
    const w = waves(byId, phase);
    if (w.includes('no outstanding work')) continue;
    md.push(`### Phase ${phase}`, '', '```text', w.trimStart(), '```', '');
  }
  return md.join('\n');
}

// ── cli ───────────────────────────────────────────────────────────────────────────────

/**
 * `scripts/lanes.ts` imports `resolveGraph` so the dispatch gate and the status oracle read
 * one graph rather than two copies that drift. Guarding the CLI keeps that import free of
 * side effects — without it, importing the oracle would run `status` and exit.
 *
 * Case-insensitive because Windows hands back `C:\CODE\...` here and `c:\code\...` there for
 * the same file, and a case-sensitive compare silently disables the CLI.
 */
function isDirectRun(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return resolve(invoked).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) main();

function main(): void {
  const byId = resolveGraph();
  const [cmd = 'status', arg] = process.argv.slice(2);

  switch (cmd) {
    case 'status':
      console.log('\nLenGentic delivery oracle — probed, not asserted\n');
      console.log(summary(byId));
      console.log('\nOpen decisions:\n');
      console.log(decisions());
      console.log('\nUnblocked now:\n');
      console.log(ready(byId));
      console.log('');
      break;

    case 'matrix':
      console.log(matrix(byId));
      console.log('');
      break;

    case 'ready':
      console.log(ready(byId));
      break;

    case 'waves': {
      const target = arg ? Number(arg) : undefined;
      for (const p of phases(byId)) {
        if (target !== undefined && p !== target) continue;
        const w = waves(byId, p);
        if (w.includes('no outstanding work') && target === undefined) continue;
        console.log(`\nPHASE ${p}${w}`);
      }
      console.log('');
      break;
    }

    case 'unblock':
      console.log('');
      console.log(unblock(byId));
      break;

    case 'packet': {
      if (!arg) {
        console.error('usage: pnpm oracle packet <node-id>');
        process.exit(1);
      }
      console.log(packet(byId, arg));
      break;
    }

    case 'json':
      console.log(JSON.stringify([...byId.values()], null, 2));
      break;

    // The status matrix is a generated snapshot of runtime state. It lives under
    // `.artifacts/` because dynamic state in a committed doc goes stale the moment the next
    // packet lands — `pnpm oracle status` is the runtime authority, this is a convenience.
    case 'md': {
      const dest = join(ROOT, '.artifacts/oracle/PROJECT_STATUS.md');
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, markdown(byId) + '\n', 'utf8');
      console.log(`wrote ${dest}`);
      break;
    }

    default:
      console.error(
        `unknown command: ${cmd}\n` +
          'usage: pnpm oracle [status|matrix|ready|unblock|waves [n]|packet <id>|json|md]',
      );
      process.exit(1);
  }
}
