/**
 * LenGentic flow control plane — `pnpm flow next` answers ONE question deterministically:
 * **what should happen next?**
 *
 * LLMs implement and diagnose; code controls progression. A session never reconstructs the
 * phase/wave/gate transition logic in prose — it asks this command and executes the returned
 * action. The answer is derived, never stored: oracle probes (what is on disk), the
 * execution-order segments in `scripts/oracle/graph.json`, lane handoffs under
 * `.artifacts/handoffs/`, gate evidence records under `.artifacts/gates/`, and the autopilot
 * checkpoint's `step` field.
 *
 * Actions, in the order they are considered:
 *
 *   ERROR          the graph or its segment config is broken — fix the config, not the code
 *   REPAIR         the checkpoint says a bounded recovery is in flight — reconcile it first
 *   INTEGRATE      a lane has a validated DONE handoff but its work is not on this tree
 *   WAVE_GATE      integrated packets are not yet covered by a wave-gate record
 *   DISPATCH       ready packets exist whose upstream gates are all recorded
 *   BLOCKED        outstanding work exists and none of it is dispatchable
 *   PHASE_GATE     the segment's work is done and its phase gate has not been recorded
 *   ADVANCE_PHASE  the segment is gated GREEN — move to the next segment
 *   COMPLETE       the last segment is gated GREEN
 *
 * Gate records are written by `pnpm flow record <wave|phase> ...` and REQUIRE evidence paths
 * that exist — a record is a pointer to proof, never the proof itself. `.artifacts/` is
 * local by design: on a fresh clone flow re-asks for a gate rather than assuming one passed.
 * That direction is safe; the reverse is a green that lies.
 *
 * Deliberately outside `pnpm gates`: this reads `.claude/` and `.artifacts/`, and the product
 * gate must keep working with the engineering harness deleted. `pnpm check:flow` is its
 * selftest, wired into CI.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadGraph,
  resolveGraph,
  loadActivation,
  lifecycleOf,
  resolveRoles,
  type Resolved,
} from './oracle.ts';
import { evaluate, policy, repoState, unitsFor, validateHandoff } from './lanes.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATES_DIR = join(ROOT, '.artifacts/gates');
const CHECKPOINT = join(ROOT, '.claude/autopilot.local.md');

// ── segments ──────────────────────────────────────────────────────────────────────────

export interface Segment {
  id: string;
  phase: number;
  nodeIds: string[];
}

/**
 * Resolve `executionOrder` + `segments` into concrete node lists. A plain-number segment
 * owns every node of its phase; a named segment (5a/5b) owns exactly the ids listed. A
 * phase-5 node missing from both named segments, or listed in one that does not exist, is a
 * config error — silence here is how a packet falls out of delivery entirely.
 */
export function segmentsOf(byId: Map<string, Resolved>): Segment[] | { error: string } {
  const graph = loadGraph();
  const order = graph.executionOrder ?? [];
  if (order.length === 0) return { error: 'graph.executionOrder is missing or empty' };
  const named = graph.segments ?? {};
  const out: Segment[] = [];
  const claimed = new Map<string, string>();

  for (const [seg, ids] of Object.entries(named)) {
    for (const id of ids) {
      if (!byId.has(id)) return { error: `segment "${seg}" names unknown node "${id}"` };
      if (claimed.has(id)) return { error: `node "${id}" appears in two segments` };
      claimed.set(id, seg);
    }
  }

  for (const seg of order) {
    if (named[seg]) {
      const phase = byId.get(named[seg][0] ?? '')?.phase;
      if (phase === undefined) return { error: `segment "${seg}" is empty` };
      out.push({ id: seg, phase, nodeIds: [...(named[seg] ?? [])] });
      continue;
    }
    const phase = Number(seg);
    if (!Number.isInteger(phase))
      return { error: `segment "${seg}" is neither a phase number nor in graph.segments` };
    const nodeIds = [...byId.values()]
      .filter((n) => n.phase === phase && !claimed.has(n.id))
      .map((n) => n.id)
      .sort();
    if (nodeIds.length === 0) return { error: `segment "${seg}" owns no nodes` };
    out.push({ id: seg, phase, nodeIds });
  }

  // Every node of a split phase must land in exactly one named segment.
  const splitPhases = new Set(out.filter((s) => named[s.id]).map((s) => s.phase));
  for (const n of byId.values()) {
    if (splitPhases.has(n.phase) && !claimed.has(n.id)) {
      return { error: `node "${n.id}" (phase ${n.phase}) is in no segment of its split phase` };
    }
  }
  return out;
}

// ── gate records ──────────────────────────────────────────────────────────────────────

export interface GateRecord {
  gate: 'wave' | 'phase';
  segment: string;
  packets: string[];
  evidence: string[];
  head: string;
  recordedAt: string;
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '-');
}

/**
 * Which of `packets` a wave record must not name, each with the reason.
 *
 * A wave record is read back by `transition()` as proof that those packets passed a gate, and
 * nothing downstream re-checks them: `waveCoveredIn()` subtracts recorded ids from the segment's
 * DONE set, so a packet recorded while it is still TODO is covered forever and never dispatches
 * again. The Phase 4 wave gate is the worked example — two packets were oracle false greens, the
 * supervisor's record command was built from that stale packet list (`scripts/autopilot/supervise.ts`,
 * the `pnpm flow record wave` composition), and only the gate worker refusing DONE kept the lie
 * off disk. A human deciding not to run a command is not a mechanism. This is the mechanism:
 * the record cannot outlive the probes, exactly as it cannot outlive its evidence paths.
 *
 * Pure over an injected graph so `pnpm check:flow` can drive it; the CLI passes `resolveGraph()`.
 */
export function unrecordablePackets(packets: string[], byId: Map<string, Resolved>): string[] {
  const out: string[] = [];
  for (const id of packets) {
    const n = byId.get(id);
    if (!n) out.push(`${id} is in no node of the graph`);
    else if (n.state !== 'DONE') out.push(`${id} is ${n.state}, not DONE, by its own probes`);
  }
  return out;
}

export function readGateRecords(dir: string = GATES_DIR): GateRecord[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: GateRecord[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as GateRecord;
      if ((r.gate === 'wave' || r.gate === 'phase') && typeof r.segment === 'string') out.push(r);
    } catch {
      /* an unreadable record is treated as absent — the safe direction */
    }
  }
  return out;
}

/** The checkpoint's frontmatter `step` and `phase`, or nulls when there is no checkpoint. */
export function checkpointState(path: string = CHECKPOINT): {
  step: string | null;
  segment: string | null;
} {
  try {
    const text = readFileSync(path, 'utf8');
    return {
      step: text.match(/^step:\s*(\S+)/m)?.[1] ?? null,
      segment: text.match(/^phase:\s*(\S+)/m)?.[1] ?? null,
    };
  } catch {
    return { step: null, segment: null };
  }
}

// ── the transition function ───────────────────────────────────────────────────────────

export interface FlowAction {
  action:
    | 'ERROR'
    | 'REPAIR'
    | 'INTEGRATE'
    | 'WAVE_GATE'
    | 'DISPATCH'
    | 'BLOCKED'
    | 'PHASE_GATE'
    | 'ADVANCE_PHASE'
    | 'COMPLETE';
  segment?: string;
  phase?: number;
  packets?: string[];
  mode?: 'sequential' | 'parallel';
  agents?: string[];
  steps?: string[];
  reason?: string;
  from?: string;
  to?: string;
}

export interface FlowInputs {
  byId: Map<string, Resolved>;
  records: GateRecord[];
  step: string | null;
  /** The checkpoint's `phase` frontmatter — which segment the last session believed it was in. */
  checkpointSegment?: string | null;
  /** task_id → true when a validated DONE lane handoff exists for a not-yet-DONE node. */
  integratable: Set<string>;
  /** Fixture seams. Defaults read the real graph; the selftest injects both. */
  segments?: Segment[] | { error: string };
  decide?: (ids: string[]) => { mode: 'sequential' | 'parallel'; order: string[] };
}

/** Transitive in-segment dependency test: does `id` depend on any node in `targets`? */
function dependsOn(
  id: string,
  targets: Set<string>,
  byId: Map<string, Resolved>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  const n = byId.get(id);
  if (!n) return false;
  for (const d of n.needs) {
    if (targets.has(d)) return true;
    if (dependsOn(d, targets, byId, seen)) return true;
  }
  return false;
}

function gateAgents(nodes: Resolved[], bucket: 'perWave' | 'perPhase'): string[] {
  const activation = loadActivation();
  const caps = new Set<string>();
  for (const n of nodes) {
    const rule = n.changeClass ? lifecycleOf(n.changeClass, activation) : null;
    for (const c of rule?.[bucket] ?? []) caps.add(c);
  }
  return resolveRoles([...caps].sort(), activation);
}

/**
 * Pure transition function over pre-gathered inputs, so the selftest can drive it without a
 * repository in every state. `nextAction()` below gathers the real inputs.
 */
export function transition(inputs: FlowInputs): FlowAction {
  const { byId, records, step, integratable } = inputs;
  const decide =
    inputs.decide ??
    ((ids: string[]) => {
      const d = evaluate(unitsFor(ids), policy(), repoState());
      return { mode: d.mode, order: d.dependency_order };
    });

  const segs = inputs.segments ?? segmentsOf(byId);
  if ('error' in segs) return { action: 'ERROR', reason: segs.error };

  if (step === 'recovering') {
    return {
      action: 'REPAIR',
      reason:
        'checkpoint step is `recovering` — reconcile it per autopilot §1 (stale recovery is discarded; a live red resumes its bounded attempt)',
    };
  }

  // The current segment: the first with outstanding work, or the first that still owes a
  // gate. A segment owes a gate while any DONE packet is uncovered by a wave record, or its
  // phase record is missing.
  //
  // One exception, and its discriminator matters: a segment delivered before
  // `pnpm flow record` existed has NO record and never will, so once later work has started
  // history closes it — demanding a gate there is busywork forever. But "later work landed"
  // is the wrong test on its own. A segment that HAS a record is inside the record regime,
  // so an uncovered packet there is a debt, not a completed phase being reopened. Using
  // `laterWorkStarted` alone let a phase with a mid-regime wave still ungated be dropped
  // silently, and the supervisor then advanced past it worker-free — the gate was never
  // skipped by a decision, it was skipped by a selection nobody could see.
  const nodes = (s: Segment): Resolved[] =>
    s.nodeIds
      .map((id) => byId.get(id))
      .filter((n): n is Resolved => n !== undefined && !n.optional);
  const laterWorkStarted = (i: number): boolean =>
    segs.slice(i + 1).some((s) => nodes(s).some((n) => n.state !== 'TODO'));
  const waveCoveredIn = (segment: string): Set<string> =>
    new Set(
      records.filter((r) => r.gate === 'wave' && r.segment === segment).flatMap((r) => r.packets),
    );

  let current: Segment | null = null;
  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i];
    if (!s) continue;
    const segNodes = nodes(s);
    const outstanding = segNodes.filter((n) => n.state !== 'DONE');
    const phaseGated = records.some((r) => r.gate === 'phase' && r.segment === s.id);
    const covered = waveCoveredIn(s.id);
    const owesGate = !phaseGated || segNodes.some((n) => n.state === 'DONE' && !covered.has(n.id));
    const inRegime = records.some((r) => r.segment === s.id);
    const closedByHistory = !inRegime && laterWorkStarted(i);
    if (outstanding.length > 0 || (owesGate && !closedByHistory)) {
      current = s;
      break;
    }
  }
  if (current === null) {
    return { action: 'COMPLETE', reason: 'every segment is delivered and gated' };
  }

  // The checkpoint lagging behind the derived segment is the one explicit phase transition:
  // update the checkpoint and frame the next wave (wave-scoped, per frame-phase) before the
  // first dispatch of the new segment. A missing checkpoint skips the ceremony — a fresh
  // session resumes without confirmation unless a stop trigger fires.
  //
  // Forward only. The supervisor handles ADVANCE_PHASE deterministically and worker-free, on
  // the premise that the segment being left behind is delivered AND gated. When the derived
  // segment sits BEHIND the checkpoint, that premise is false by construction — something
  // owed a gate back there — so the owed gate is returned instead, and no advance is offered.
  const checkpointIndex = segs.findIndex((s) => s.id === inputs.checkpointSegment);
  const currentIndex = segs.findIndex((s) => s.id === current.id);
  if (
    inputs.checkpointSegment != null &&
    inputs.checkpointSegment !== current.id &&
    checkpointIndex !== -1 &&
    currentIndex > checkpointIndex
  ) {
    return {
      action: 'ADVANCE_PHASE',
      from: inputs.checkpointSegment,
      to: current.id,
      steps: [
        'check escalation triggers 2 and 3 against the next segment before its first dispatch',
        'rewrite .claude/autopilot.local.md frontmatter to the new segment',
        'frame ONLY the next ready wave (frame-phase, wave-scoped) if it has open decisions',
      ],
    };
  }

  const segNodes = nodes(current);
  const outstanding = segNodes.filter((n) => n.state !== 'DONE');
  const done = segNodes.filter((n) => n.state === 'DONE');
  const covered = waveCoveredIn(current.id);
  const uncovered = done.filter((n) => !covered.has(n.id));
  const uncoveredIds = new Set(uncovered.map((n) => n.id));

  // A lane finished off-tree comes first: its handoff is validated, its work is not merged.
  const toIntegrate = segNodes.filter((n) => integratable.has(n.id));
  if (toIntegrate.length > 0) {
    const order = decide(toIntegrate.map((n) => n.id).sort()).order;
    return {
      action: 'INTEGRATE',
      segment: current.id,
      phase: current.phase,
      packets: order,
      steps: [
        `pnpm lanes integrate ${order.join(' ')}`,
        'then merge in the printed order and re-run each lane’s own commands',
      ],
    };
  }

  const ready = outstanding.filter((n) => n.readiness === 'READY' || n.readiness === 'IN-PROGRESS');
  // Dispatchable now = ready work that does not build on packets whose wave gate has not run.
  const dispatchable = ready.filter((n) => !dependsOn(n.id, uncoveredIds, byId));

  if (dispatchable.length > 0) {
    const ids = dispatchable.map((n) => n.id).sort();
    const decision = decide(ids);
    return {
      action: 'DISPATCH',
      segment: current.id,
      phase: current.phase,
      packets: decision.order,
      mode: decision.mode,
      steps: [
        `pnpm lanes decide ${ids.join(' ')}   # the full execution_decision`,
        `pnpm oracle packet <id>   # one bounded brief per lane`,
      ],
    };
  }

  if (uncovered.length > 0) {
    const ids = uncovered.map((n) => n.id).sort();
    return {
      action: 'WAVE_GATE',
      segment: current.id,
      phase: current.phase,
      packets: ids,
      agents: gateAgents(uncovered, 'perWave'),
      steps: [
        'pnpm gates',
        ...gateAgents(uncovered, 'perWave').map(
          (a) => `dispatch ${a} once, over the wave's combined diff`,
        ),
        'flush .artifacts/backlog/pending.md into BACKLOG.md (dedupe, keep Source + Trigger)',
        `pnpm flow record wave --segment ${current.id} --packets ${ids.join(' ')} --evidence <artifact...>`,
      ],
    };
  }

  if (outstanding.length > 0) {
    const blockers = outstanding.map((n) => `${n.id} ← ${n.blockedBy.join(', ') || 'unknown'}`);
    return {
      action: 'BLOCKED',
      segment: current.id,
      phase: current.phase,
      reason: blockers.join('; '),
    };
  }

  // Segment fully delivered and wave-gated: phase gate, then advance.
  const phaseGated = records.some((r) => r.gate === 'phase' && r.segment === current.id);
  if (!phaseGated) {
    return {
      action: 'PHASE_GATE',
      segment: current.id,
      phase: current.phase,
      agents: gateAgents(segNodes, 'perPhase'),
      steps: [
        'pnpm gates:full',
        'validate-phase skill against the phase Definition of Done',
        ...gateAgents(segNodes, 'perPhase').map((a) => `dispatch ${a} once, over the phase's work`),
        'flush .artifacts/backlog/pending.md into BACKLOG.md',
        `pnpm flow record phase --segment ${current.id} --evidence <artifact...>`,
      ],
    };
  }
  // Unreachable by construction: a gated, finished segment is never selected as current —
  // the next call lands in the following segment and the checkpoint mismatch handles the
  // explicit advance. Kept for totality.
  return { action: 'COMPLETE', reason: `segment ${current.id} is delivered and gated` };
}

// ── gathering the real inputs ─────────────────────────────────────────────────────────

async function integratableLanes(byId: Map<string, Resolved>): Promise<Set<string>> {
  const out = new Set<string>();
  const dir = join(ROOT, '.artifacts/handoffs');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const n of byId.values()) {
    if (n.state === 'DONE') continue;
    const name = `${n.phase}-${n.id}-${n.owner}.json`;
    if (!files.includes(name)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const unit = unitsFor([n.id])[0] ?? null;
      const verdict = await validateHandoff(parsed, unit, { checkCommit: true });
      if (verdict.ok && verdict.status === 'DONE') out.add(n.id);
    } catch {
      /* an unreadable handoff is not a DONE lane */
    }
  }
  return out;
}

export async function nextAction(): Promise<FlowAction> {
  const byId = resolveGraph();
  const checkpoint = checkpointState();
  return transition({
    byId,
    records: readGateRecords(),
    step: checkpoint.step,
    checkpointSegment: checkpoint.segment,
    integratable: await integratableLanes(byId),
  });
}

// ── cli ───────────────────────────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

function flagList(argv: string[], name: string): string[] {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return [];
  const out: string[] = [];
  for (let j = i + 1; j < argv.length; j += 1) {
    const a = argv[j];
    if (a === undefined || a.startsWith('--')) break;
    out.push(a);
  }
  return out;
}

function isDirectRun(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return resolve(invoked).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'next';

  switch (cmd) {
    case 'next': {
      const action = await nextAction();
      console.log(JSON.stringify(action, null, 2));
      // BLOCKED and ERROR are states the caller must act on, but only ERROR is a failure of
      // this command itself — a BLOCKED delivery is a correct, honest answer.
      if (action.action === 'ERROR') process.exit(1);
      break;
    }

    case 'record': {
      const gate = argv[1];
      if (gate !== 'wave' && gate !== 'phase') {
        console.error(
          'usage: pnpm flow record <wave|phase> --segment <id> [--packets <id...>] --evidence <path...>',
        );
        process.exit(1);
      }
      const segment = flag(argv, 'segment');
      const packets = flagList(argv, 'packets');
      const evidence = flagList(argv, 'evidence');
      if (!segment || evidence.length === 0 || (gate === 'wave' && packets.length === 0)) {
        console.error(
          'a gate record needs --segment, --evidence (at least one artifact path), and --packets for a wave gate',
        );
        process.exit(1);
      }
      const missing = evidence.filter((e) => !existsSync(join(ROOT, e)) && !existsSync(e));
      if (missing.length > 0) {
        console.error(
          `evidence paths do not exist: ${missing.join(', ')} — a record points at proof`,
        );
        process.exit(1);
      }
      if (gate === 'wave') {
        const unrecordable = unrecordablePackets(packets, resolveGraph());
        if (unrecordable.length > 0) {
          console.error(
            [
              'refusing to record a wave gate over packets the probes do not call DONE:',
              ...unrecordable.map((w) => `  ${w}`),
              'a wave record is permanent coverage — recording an unbuilt packet retires it unbuilt',
            ].join('\n'),
          );
          process.exit(1);
        }
      }
      const head = ((): string => {
        try {
          return readFileSync(join(ROOT, '.git/HEAD'), 'utf8').trim();
        } catch {
          return 'unknown';
        }
      })();
      const record: GateRecord = {
        gate,
        segment,
        packets: packets.sort(),
        evidence,
        head,
        recordedAt: new Date().toISOString(),
      };
      mkdirSync(GATES_DIR, { recursive: true });
      const name =
        gate === 'phase'
          ? `phase-${slugify(segment)}.json`
          : `wave-${slugify(segment)}-${slugify(packets.sort().join('+'))}.json`;
      writeFileSync(join(GATES_DIR, name), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      console.log(`recorded ${gate} gate for segment ${segment} → .artifacts/gates/${name}`);
      break;
    }

    default:
      console.error(
        'usage: pnpm flow <command>\n' +
          '  next                                             what should happen next (JSON)\n' +
          '  record <wave|phase> --segment <id>\n' +
          '         [--packets <id...>] --evidence <path...>  record a passed gate',
      );
      process.exit(1);
  }
}

if (isDirectRun()) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
