/**
 * Scenarios for the flow control plane — `pnpm check:flow`.
 *
 * These drive `transition()` with fixture inputs, so every progression state is exercised
 * without needing the repository to be in that state. The last scenarios run against the
 * live graph, asserting the segment config is coherent and `pnpm flow next` returns a real
 * action for the tree as it stands.
 *
 * The letters reference the harness-validation checklist this file was built against:
 * wave gate exactly once (H), phase gate exactly once then auto-advance (I), no-outstanding-
 * work is a machine state and not a generic failure (J), a fresh session resumes without a
 * human confirmation unless a stop trigger exists (K), recovery surfaces as REPAIR and a
 * dead end as BLOCKED (F), and an unclear failure routes to Diagnostician (G).
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  transition,
  segmentsOf,
  unrecordablePackets,
  type FlowAction,
  type FlowInputs,
  type GateRecord,
  type Segment,
} from '../flow.ts';
import {
  lifecycleOf,
  loadActivation,
  resolveGraph,
  resolveRoles,
  type Resolved,
} from '../oracle.ts';

interface Result {
  n: number;
  name: string;
  pass: boolean;
  detail: string;
}

const results: Result[] = [];

function scenario(n: number, name: string, fn: () => string | null): void {
  let detail: string | null;
  try {
    detail = fn();
  } catch (e: unknown) {
    detail = `threw: ${e instanceof Error ? e.message : String(e)}`;
  }
  results.push({ n, name, pass: detail === null, detail: detail ?? 'ok' });
}

function expect(cond: boolean, message: string): string | null {
  return cond ? null : message;
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────

function node(over: Partial<Resolved> & { id: string; phase: number }): Resolved {
  return {
    lane: 'fixture',
    title: `fixture ${over.id}`,
    owner: 'builder',
    needs: [],
    probes: [],
    changeClass: 'behavior',
    state: 'TODO',
    hits: 0,
    blockedBy: [],
    readiness: 'READY',
    depth: 0,
    wave: 1,
    ...over,
  };
}

function world(nodes: Resolved[]): Map<string, Resolved> {
  return new Map(nodes.map((n) => [n.id, n]));
}

function seg(id: string, phase: number, nodeIds: string[]): Segment {
  return { id, phase, nodeIds };
}

function waveRecord(segment: string, packets: string[]): GateRecord {
  return {
    gate: 'wave',
    segment,
    packets,
    evidence: ['.artifacts/evidence/fixture.md'],
    head: 'fixture',
    recordedAt: '2026-08-19T00:00:00.000Z',
  };
}

function phaseRecord(segment: string): GateRecord {
  return { ...waveRecord(segment, []), gate: 'phase' };
}

function run(
  over: Partial<FlowInputs> & { byId: Map<string, Resolved>; segments: Segment[] },
): FlowAction {
  return transition({
    records: [],
    step: null,
    integratable: new Set<string>(),
    decide: (ids) => ({ mode: 'sequential', order: [...ids].sort() }),
    ...over,
  });
}

// A two-segment world: segment "9" has a two-node wave then a dependent node; segment "10"
// follows. Enough shape to exercise every transition.
const A = () => node({ id: 'a', phase: 9 });
const B = () => node({ id: 'b', phase: 9 });
const C = () =>
  node({ id: 'c', phase: 9, needs: ['a', 'b'], readiness: 'BLOCKED', blockedBy: ['a', 'b'] });
const Z = () => node({ id: 'z', phase: 10 });
const SEGS = [seg('9', 9, ['a', 'b', 'c']), seg('10', 10, ['z'])];

// ── scenarios ─────────────────────────────────────────────────────────────────────────

export function run_(): number {
  scenario(1, 'K: a fresh tree with ready work dispatches — no confirmation state exists', () => {
    const action = run({ byId: world([A(), B(), C(), Z()]), segments: SEGS });
    return (
      expect(action.action === 'DISPATCH', `expected DISPATCH, got ${action.action}`) ??
      expect(
        action.packets?.join(',') === 'a,b',
        `expected packets a,b; got ${action.packets?.join(',')}`,
      ) ??
      expect(action.segment === '9', `expected segment 9, got ${action.segment}`)
    );
  });

  scenario(2, 'H: a finished wave demands its gate exactly once, then the next wave flows', () => {
    const done = [
      node({ id: 'a', phase: 9, state: 'DONE', readiness: 'DONE' }),
      node({ id: 'b', phase: 9, state: 'DONE', readiness: 'DONE' }),
      node({ id: 'c', phase: 9, needs: ['a', 'b'] }),
      Z(),
    ];
    const beforeGate = run({ byId: world(done), segments: SEGS });
    const afterGate = run({
      byId: world(done),
      segments: SEGS,
      records: [waveRecord('9', ['a', 'b'])],
    });
    return (
      expect(beforeGate.action === 'WAVE_GATE', `expected WAVE_GATE, got ${beforeGate.action}`) ??
      expect(
        beforeGate.packets?.join(',') === 'a,b',
        `the gate covers the finished wave; got ${beforeGate.packets?.join(',')}`,
      ) ??
      expect(
        (beforeGate.steps ?? []).some((s) => s.includes('pnpm gates')) &&
          !(beforeGate.steps ?? []).some((s) => s.includes('gates:full')),
        'the wave gate runs pnpm gates, never gates:full',
      ) ??
      expect(
        (beforeGate.steps ?? []).some((s) => s.includes('backlog')),
        'the wave gate flushes the batched backlog once',
      ) ??
      expect(
        beforeGate.agents?.includes('validator') === true,
        `a behavior wave puts validator at the gate; got ${beforeGate.agents?.join(',')}`,
      ) ??
      expect(
        afterGate.action === 'DISPATCH',
        `after the record the next wave flows; got ${afterGate.action}`,
      ) ??
      expect(
        afterGate.packets?.join(',') === 'c',
        `expected packet c; got ${afterGate.packets?.join(',')}`,
      )
    );
  });

  scenario(3, 'a ready sibling in the same wave dispatches before the gate fires', () => {
    const mixed = [
      node({ id: 'a', phase: 9, state: 'DONE', readiness: 'DONE' }),
      B(), // same wave as a, still outstanding, no dependency on a
      node({ id: 'c', phase: 9, needs: ['a', 'b'], readiness: 'BLOCKED', blockedBy: ['b'] }),
      Z(),
    ];
    const action = run({ byId: world(mixed), segments: SEGS });
    return (
      expect(
        action.action === 'DISPATCH',
        `expected DISPATCH of the sibling, got ${action.action}`,
      ) ?? expect(action.packets?.join(',') === 'b', `expected b; got ${action.packets?.join(',')}`)
    );
  });

  scenario(
    4,
    'I+J: a finished segment is PHASE_GATE once, then ADVANCE_PHASE — never an error',
    () => {
      const allDone = [
        node({ id: 'a', phase: 9, state: 'DONE', readiness: 'DONE' }),
        node({ id: 'b', phase: 9, state: 'DONE', readiness: 'DONE' }),
        node({ id: 'c', phase: 9, state: 'DONE', readiness: 'DONE', needs: ['a', 'b'] }),
        Z(),
      ];
      const covered = [waveRecord('9', ['a', 'b', 'c'])];
      const beforeGate = run({ byId: world(allDone), segments: SEGS, records: covered });
      // The checkpoint still says segment 9: the one explicit transition is ADVANCE_PHASE.
      const afterGate = run({
        byId: world(allDone),
        segments: SEGS,
        records: [...covered, phaseRecord('9')],
        checkpointSegment: '9',
      });
      // Once the checkpoint is rewritten (or absent — a fresh session), work flows directly.
      const afterAdvance = run({
        byId: world(allDone),
        segments: SEGS,
        records: [...covered, phaseRecord('9')],
        checkpointSegment: '10',
      });
      return (
        expect(
          afterAdvance.action === 'DISPATCH' && afterAdvance.segment === '10',
          `after the advance: DISPATCH in 10, got ${afterAdvance.action} in ${afterAdvance.segment}`,
        ) ??
        expect(
          beforeGate.action === 'PHASE_GATE',
          `expected PHASE_GATE, got ${beforeGate.action}`,
        ) ??
        expect(
          (beforeGate.steps ?? []).some((s) => s.includes('gates:full')) &&
            (beforeGate.steps ?? []).some((s) => s.includes('validate-phase')),
          'the phase gate runs gates:full and validate-phase',
        ) ??
        expect(
          beforeGate.agents?.includes('reviewer') === true &&
            beforeGate.agents?.includes('tester') === true,
          `behavior work defers reviewer and tester to the phase gate; got ${beforeGate.agents?.join(',')}`,
        ) ??
        expect(
          afterGate.action === 'ADVANCE_PHASE',
          `after the record: ADVANCE_PHASE, got ${afterGate.action}`,
        ) ??
        expect(
          afterGate.from === '9' && afterGate.to === '10',
          `expected 9→10, got ${afterGate.from}→${afterGate.to}`,
        )
      );
    },
  );

  scenario(
    5,
    'J: the last gated segment is COMPLETE — a machine state, not an exit-1 failure',
    () => {
      const allDone = [
        node({ id: 'a', phase: 9, state: 'DONE', readiness: 'DONE' }),
        node({ id: 'b', phase: 9, state: 'DONE', readiness: 'DONE' }),
        node({ id: 'c', phase: 9, state: 'DONE', readiness: 'DONE' }),
        node({ id: 'z', phase: 10, state: 'DONE', readiness: 'DONE' }),
      ];
      const action = run({
        byId: world(allDone),
        segments: SEGS,
        records: [
          waveRecord('9', ['a', 'b', 'c']),
          waveRecord('10', ['z']),
          phaseRecord('9'),
          phaseRecord('10'),
        ],
      });
      return expect(action.action === 'COMPLETE', `expected COMPLETE, got ${action.action}`);
    },
  );

  scenario(6, 'F: a checkpoint mid-recovery surfaces REPAIR; a dead end surfaces BLOCKED', () => {
    const recovering = run({ byId: world([A(), Z()]), segments: SEGS, step: 'recovering' });
    const stuck = run({
      byId: world([
        node({ id: 'a', phase: 9, readiness: 'BLOCKED', blockedBy: ['env.something'] }),
        Z(),
      ]),
      segments: [seg('9', 9, ['a']), seg('10', 10, ['z'])],
    });
    return (
      expect(recovering.action === 'REPAIR', `expected REPAIR, got ${recovering.action}`) ??
      expect(stuck.action === 'BLOCKED', `expected BLOCKED, got ${stuck.action}`) ??
      expect(
        (stuck.reason ?? '').includes('env.something'),
        `BLOCKED names its blocker; got ${stuck.reason}`,
      )
    );
  });

  scenario(
    7,
    'a validated DONE handoff routes to INTEGRATE before anything else dispatches',
    () => {
      const action = run({
        byId: world([A(), B(), C(), Z()]),
        segments: SEGS,
        integratable: new Set(['a']),
      });
      return (
        expect(action.action === 'INTEGRATE', `expected INTEGRATE, got ${action.action}`) ??
        expect(action.packets?.join(',') === 'a', `expected a; got ${action.packets?.join(',')}`)
      );
    },
  );

  scenario(8, 'a completed segment with later work already landed is historically closed', () => {
    // Segment 9 is done but has no gate records — and segment 10 already has DONE work.
    // Re-gating 9 would reopen a completed phase; flow must move on.
    const action = run({
      byId: world([
        node({ id: 'a', phase: 9, state: 'DONE', readiness: 'DONE' }),
        node({ id: 'b', phase: 9, state: 'DONE', readiness: 'DONE' }),
        node({ id: 'c', phase: 9, state: 'DONE', readiness: 'DONE' }),
        node({ id: 'z', phase: 10, state: 'PARTIAL', readiness: 'IN-PROGRESS' }),
      ]),
      segments: SEGS,
    });
    return (
      expect(
        action.action === 'DISPATCH',
        `expected DISPATCH in segment 10, got ${action.action}`,
      ) ?? expect(action.segment === '10', `expected segment 10, got ${action.segment}`)
    );
  });

  scenario(
    13,
    'a segment already inside the record regime is never historically closed while it owes a gate',
    () => {
      // The discriminator is not "did later work land" — it is "was this segment ever gated
      // under the record regime". A segment with zero records predates `pnpm flow record`
      // and is closed by history (scenario 8). A segment that HAS records is inside the
      // regime, so an uncovered DONE packet is a gate it still owes, whatever landed after.
      const world9Done = () =>
        world([
          node({ id: 'a', phase: 9, state: 'DONE', readiness: 'DONE' }),
          node({ id: 'b', phase: 9, state: 'DONE', readiness: 'DONE' }),
          node({ id: 'c', phase: 9, state: 'DONE', readiness: 'DONE' }),
          node({ id: 'z', phase: 10, state: 'PARTIAL', readiness: 'IN-PROGRESS' }),
        ]);
      // Waves 1-2 recorded; the third packet never appeared in any record.
      const owesWave = run({
        byId: world9Done(),
        segments: SEGS,
        records: [waveRecord('9', ['a', 'b'])],
      });
      // Every packet wave-covered, but the phase gate never ran.
      const owesPhase = run({
        byId: world9Done(),
        segments: SEGS,
        records: [waveRecord('9', ['a', 'b']), waveRecord('9', ['c'])],
      });
      // Fully gated: history closes it and flow moves on, exactly as scenario 8.
      const settled = run({
        byId: world9Done(),
        segments: SEGS,
        records: [waveRecord('9', ['a', 'b', 'c']), phaseRecord('9')],
      });
      return (
        expect(
          owesWave.action === 'WAVE_GATE' && owesWave.segment === '9',
          `an uncovered DONE packet owes its wave gate; got ${owesWave.action} in ${owesWave.segment}`,
        ) ??
        expect(
          owesWave.packets?.join(',') === 'c',
          `the gate covers only the uncovered packet; got ${owesWave.packets?.join(',')}`,
        ) ??
        expect(
          owesPhase.action === 'PHASE_GATE' && owesPhase.segment === '9',
          `a wave-covered segment still owes its phase gate; got ${owesPhase.action} in ${owesPhase.segment}`,
        ) ??
        expect(
          settled.action === 'DISPATCH' && settled.segment === '10',
          `a fully gated segment is closed; got ${settled.action} in ${settled.segment}`,
        )
      );
    },
  );

  scenario(
    14,
    'ADVANCE_PHASE only ever moves forward — a checkpoint ahead of the owed gate does not skip it',
    () => {
      // The supervisor handles ADVANCE_PHASE worker-free, on the premise that the previous
      // segment is delivered AND gated. Firing it backwards would declare a segment complete
      // that never ran its gate, with no worker in the loop to notice.
      const action = run({
        byId: world([
          node({ id: 'a', phase: 9, state: 'DONE', readiness: 'DONE' }),
          node({ id: 'b', phase: 9, state: 'DONE', readiness: 'DONE' }),
          node({ id: 'c', phase: 9, state: 'DONE', readiness: 'DONE' }),
          node({ id: 'z', phase: 10, state: 'PARTIAL', readiness: 'IN-PROGRESS' }),
        ]),
        segments: SEGS,
        records: [waveRecord('9', ['a', 'b'])],
        checkpointSegment: '10',
      });
      return (
        expect(
          action.action !== 'ADVANCE_PHASE',
          `expected the owed gate, not a backwards advance; got ${action.from}->${action.to}`,
        ) ??
        expect(
          action.action === 'WAVE_GATE' && action.segment === '9',
          `expected WAVE_GATE in 9; got ${action.action} in ${action.segment}`,
        )
      );
    },
  );

  scenario(9, 'G: the diagnosis class routes Diagnostician first, then Builder', () => {
    const activation = loadActivation();
    const rule = lifecycleOf('diagnosis', activation);
    if (!rule) return 'no `diagnosis` class in agent-activation.json';
    const chain = resolveRoles(rule.perPacket, activation);
    const conditions = activation.activationConditions?.diagnose ?? [];
    return (
      expect(
        chain.join(',') === 'diagnostician,builder',
        `expected diagnostician,builder; got ${chain.join(',')}`,
      ) ?? expect(conditions.length > 0, 'diagnose must document when it fires')
    );
  });

  scenario(10, 'a broken segment config is an ERROR action, never a silent skip', () => {
    const broken = transition({
      byId: world([A(), Z()]),
      records: [],
      step: null,
      integratable: new Set(),
      segments: { error: 'node "stray" (phase 9) is in no segment of its split phase' },
    });
    return expect(
      broken.action === 'ERROR' && (broken.reason ?? '').includes('stray'),
      `expected ERROR naming stray; got ${broken.action}: ${broken.reason}`,
    );
  });

  scenario(11, 'the live graph has a coherent segment config', () => {
    const byId = resolveGraph();
    const segs = segmentsOf(byId);
    if ('error' in segs) return `live segment config is broken: ${segs.error}`;
    const ids = segs.map((s) => s.id);
    const claimed = new Set(segs.flatMap((s) => s.nodeIds));
    const unclaimed = [...byId.values()].filter((n) => !claimed.has(n.id));
    return (
      expect(
        ids.join(' ') === '1 5a 2 3 4 5b 6 7',
        `execution order must match CLAUDE.md; got ${ids.join(' ')}`,
      ) ??
      expect(
        unclaimed.length === 0,
        `every node belongs to a segment; unclaimed: ${unclaimed.map((n) => n.id).join(',')}`,
      )
    );
  });

  scenario(12, 'the live tree resolves to a real action right now', () => {
    const byId = resolveGraph();
    const action = transition({
      byId,
      records: [],
      step: null,
      integratable: new Set(),
      decide: (ids) => ({ mode: 'sequential', order: [...ids].sort() }),
    });
    return expect(
      action.action !== 'ERROR',
      `the live graph must produce a non-ERROR action; got ${JSON.stringify(action)}`,
    );
  });

  scenario(15, 'a wave record naming a packet the probes do not call DONE is refused', () => {
    const byId = new Map<string, Resolved>([
      ['a', node({ id: 'a', phase: 4, state: 'DONE' })],
      ['b', node({ id: 'b', phase: 4, state: 'TODO' })],
      ['c', node({ id: 'c', phase: 4, state: 'PARTIAL' })],
    ]);
    const clean = unrecordablePackets(['a'], byId);
    const dirty = unrecordablePackets(['a', 'b', 'c', 'ghost'], byId);
    return (
      expect(clean.length === 0, `an all-DONE packet list must record; got ${clean.join(', ')}`) ??
      expect(
        dirty.length === 3 && dirty.every((w) => /^(b|c|ghost) /.test(w)),
        'TODO, PARTIAL and unknown packets must each be refused by name; got ' +
          JSON.stringify(dirty),
      )
    );
  });

  return report();
}

function report(): number {
  const failed = results.filter((r) => !r.pass);
  console.log('\nflow control-plane scenarios\n');
  for (const r of results.sort((a, b) => a.n - b.n)) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${String(r.n).padStart(2)}  ${r.name}`);
    if (!r.pass) console.log(`              ${r.detail}`);
  }
  console.log(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  return failed.length === 0 ? 0 : 1;
}

function isDirectRun(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return resolve(invoked).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) {
  process.exit(run_());
}
