/**
 * Scenarios for `pnpm decide`.
 *
 * The negative fixtures come first and outnumber the positive ones on purpose: a decision
 * index that returns *something* for every question looks like it works right up until the
 * something is wrong. `CLAUDE.md` calls that a green that lies. Scenarios 1-9 are the four
 * false-positive shapes named in `.artifacts/plans/pnpm-decide-plan.md` §6 — each must come
 * back `NOVEL`, or must be excluded from a `FOUND` verdict, never silently presented as a
 * confident answer.
 *
 * A handful of scenarios run against the live repository on purpose, the same reasoning
 * `scripts/kb/selftest.ts` uses: whether `ask` finds ADR 0002 for a real dispatch question,
 * and whether `why` joins OD-4 and ADR-0004 on `p5.repeated-failed`, are claims about *this*
 * repository, not about the algorithm in the abstract.
 *
 *   pnpm check:decide      (or)     tsx scripts/decide/selftest.ts
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  ask,
  AdrParseError,
  build,
  detect,
  loadBacklog,
  loadContext,
  loadLaneEvents,
  loadOracleDecisions,
  loadPlan,
  open,
  parseAdr,
  parseBacklog,
  route,
  statusLabel,
  why,
  type DecisionNode,
} from '../decide.ts';

// ── harness ───────────────────────────────────────────────────────────────────────────

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
  results.push({ n, name, pass: detail === null, detail: detail ?? '' });
}

function node(over: Partial<DecisionNode>): DecisionNode {
  return {
    id: 'X-1',
    kind: 'settled',
    question: 'placeholder question',
    answer: 'placeholder answer',
    status: 'answered',
    decidedBy: 'human',
    decidedOn: null,
    learnedWrong: null,
    detection: null,
    source: 'FAKE.md:1',
    ...over,
  };
}

// ── negative fixtures — the four false-positive shapes ──────────────────────────────

scenario(1, 'shape 1: near-miss keyword overlap returns NOVEL, not the loose match', () => {
  const nodes = [
    node({
      id: 'X-gates',
      question: 'should the gate threshold be injectable?',
      answer: 'yes, via AnalyzerConfig',
    }),
  ];
  // Shares only "the" (stopword) and "should" with the fixture; must not clear the floor.
  const r = ask(nodes, 'should the dashboard use dark mode by default');
  return r.verdict === 'NOVEL' ? null : `expected NOVEL, got FOUND: ${JSON.stringify(r)}`;
});

scenario(2, 'shape 2: `answered: true` with no answer text is never surfaced as decided', () => {
  const nodes = [
    node({
      id: 'OD-9',
      kind: 'blocking',
      question: 'is X the threshold',
      answer: null,
      status: 'answered',
    }),
  ];
  const r = ask(nodes, 'is X the threshold');
  return r.verdict === 'NOVEL'
    ? null
    : `expected NOVEL for a null-answer node, got: ${JSON.stringify(r)}`;
});

scenario(3, 'shape 3: a superseded record is never returned as a live answer', () => {
  const nodes = [
    node({
      id: 'ADR-0099',
      question: 'is caching enabled by default',
      answer: 'yes, caching is enabled by default',
      status: { supersededBy: 'ADR-0100' },
    }),
  ];
  const r = ask(nodes, 'is caching enabled by default');
  return r.verdict === 'NOVEL'
    ? null
    : `expected NOVEL for a superseded node, got: ${JSON.stringify(r)}`;
});

scenario(
  4,
  'shape 4: a BACKLOG entry whose trigger has not fired reads as deferred, not done',
  () => {
    const nodes = parseBacklog(
      '### Build the widget\n\n**Source:** human, 2026-08-17.\n\n**Trigger:** after phase 9 ships.\n',
    );
    const first = nodes[0];
    if (!first) return 'expected one parsed BACKLOG node';
    if (first.answer === null) return 'expected a non-null deferred answer';
    return /deferred/i.test(first.answer) && /phase 9/i.test(first.answer)
      ? null
      : `expected the answer to read as deferred and cite the trigger, got: "${first.answer}"`;
  },
);

scenario(5, 'a "Trigger: none" entry reads as in force, not deferred', () => {
  const nodes = parseBacklog(
    '### Adopt the ladder\n\n**Source:** human, 2026-08-17.\n\n**Trigger:** none — in force now.\n',
  );
  const first = nodes[0];
  return first?.answer && /in force/i.test(first.answer)
    ? null
    : `expected "in force" in the answer, got: ${JSON.stringify(first?.answer)}`;
});

// ── ask: confidence floor mechanics ──────────────────────────────────────────────────

scenario(6, 'a strong overlap clears the floor and returns FOUND with a citation', () => {
  const nodes = [
    node({
      id: 'ADR-0042',
      question: 'sequential dispatch is the default',
      answer: 'parallelism is never decided by judgement',
      source: 'FAKE.md:7',
    }),
  ];
  const r = ask(nodes, 'is sequential dispatch the default here');
  if (r.verdict !== 'FOUND') return `expected FOUND, got ${r.verdict}`;
  return r.hits[0]?.node.id === 'ADR-0042'
    ? null
    : `expected ADR-0042 first, got ${JSON.stringify(r.hits)}`;
});

scenario(7, 'an empty question returns NOVEL rather than throwing', () => {
  const r = ask([node({})], '   ');
  return r.verdict === 'NOVEL'
    ? null
    : `expected NOVEL for an empty question, got ${JSON.stringify(r)}`;
});

// ── ADR parser ────────────────────────────────────────────────────────────────────────

const ADR_OK = `---
number: 0099
title: A fake decision for the parser test
date: 2026-08-17
status: accepted
---

## Context

Something happened.

## Decision

The fake thing was chosen.

## Consequences

It costs nothing.

## Detection

If it is ever wrong, this shows it.
`;

scenario(8, 'a well-formed ADR parses into a settled, answered node', () => {
  const n = parseAdr('docs/decisions/0099-fake.md', ADR_OK);
  if (n.id !== 'ADR-0099') return `expected ADR-0099, got ${n.id}`;
  if (n.status !== 'answered') return `expected answered, got ${statusLabel(n.status)}`;
  return n.answer === 'The fake thing was chosen.'
    ? null
    : `expected the Decision section as the answer, got: "${n.answer}"`;
});

scenario(9, 'a missing Detection heading is a loud parse failure, not a skip', () => {
  const missing = ADR_OK.replace(/## Detection[\s\S]*$/, '');
  try {
    parseAdr('docs/decisions/0099-fake.md', missing);
    return 'expected parseAdr to throw AdrParseError';
  } catch (e) {
    return e instanceof AdrParseError ? null : `expected AdrParseError, got ${String(e)}`;
  }
});

scenario(10, 'a "superseded by NNNN" status is captured as a link, not swallowed', () => {
  const superseded = ADR_OK.replace('status: accepted', 'status: superseded by 0100');
  const n = parseAdr('docs/decisions/0099-fake.md', superseded);
  return typeof n.status === 'object' &&
    'supersededBy' in n.status &&
    n.status.supersededBy === 'ADR-0100'
    ? null
    : `expected supersededBy ADR-0100, got ${statusLabel(n.status)}`;
});

// ── live repository ───────────────────────────────────────────────────────────────────

scenario(11, 'oracle graph decisions carry `answered: true` and no answer text, honestly', () => {
  const decisions = loadOracleDecisions();
  if (decisions.length === 0) return 'expected at least one OD node from scripts/oracle/graph.json';
  const bad = decisions.find((d) => d.status === 'answered' && d.answer !== null);
  return bad
    ? `expected every OD node to carry answer: null, but ${bad.id} has "${bad.answer}"`
    : null;
});

scenario(
  12,
  '`pnpm decide ask` finds ADR 0002 for a real dispatch question, with a citation',
  () => {
    const r = ask(build().nodes, 'should dispatch be parallel or sequential by default');
    if (r.verdict !== 'FOUND') return `expected FOUND, got NOVEL`;
    const hit = r.hits.find((h) => h.node.id === 'ADR-0002');
    if (!hit) return `expected ADR-0002 among hits, got ${r.hits.map((h) => h.node.id).join(', ')}`;
    return /docs\/decisions\/0002.*:\d+/.test(hit.citation)
      ? null
      : `expected a file:line citation, got "${hit.citation}"`;
  },
);

scenario(13, 'a question with no prior decision returns NOVEL against the live index', () => {
  const r = ask(build().nodes, 'what shade of purple should the login button use');
  return r.verdict === 'NOVEL'
    ? null
    : `expected NOVEL, got ${JSON.stringify((r as { hits: unknown }).hits)}`;
});

scenario(14, '`why p5.repeated-failed` joins OD-4 and ADR-0004', () => {
  const found = why(build(), 'p5.repeated-failed');
  const ids = found.map((n) => n.id);
  if (!ids.includes('OD-4')) return `expected OD-4, got ${ids.join(', ')}`;
  return ids.includes('ADR-0004') ? null : `expected ADR-0004, got ${ids.join(', ')}`;
});

scenario(15, 'a task with no constraining decision returns an empty list, not a guess', () => {
  const found = why(build(), 'no-such-task-id-anywhere');
  return found.length === 0 ? null : `expected [], got ${found.map((n) => n.id).join(', ')}`;
});

scenario(
  16,
  'the `pnpm decide` BACKLOG entry itself reads as deferred, its own trigger unfired',
  () => {
    const entries = loadBacklog().filter((n) => /pnpm decide/i.test(n.question));
    const self = entries.find((n) => /one generated index/i.test(n.question));
    if (!self)
      return `expected to find the "pnpm decide" BACKLOG entry, got: ${entries.map((n) => n.question).join(' | ')}`;
    return self.answer && /5a gate/i.test(self.answer)
      ? null
      : `expected the answer to cite the unfired 5a-gate trigger, got: "${self.answer}"`;
  },
);

scenario(17, 'CONTEXT.md loads as definitional nodes with a citable definition', () => {
  const nodes = loadContext();
  const key = nodes.find((n) => n.id === 'CTX-contextkey');
  if (!key) return `expected CTX-contextkey among ${nodes.length} nodes`;
  return key.answer && /caller/i.test(key.answer)
    ? null
    : `expected caller-computed in the answer, got "${key.answer}"`;
});

scenario(18, 'MVP_PLAN_V3.md loads only top-level numbered sections, answer is the heading', () => {
  const nodes = loadPlan();
  if (nodes.length === 0) return 'expected at least one PLAN-* node';
  const bad = nodes.find(
    (n) => n.answer !== null && n.answer.length > 0 && n.id.replace('PLAN-', '') === '',
  );
  if (bad) return `expected every PLAN node to carry a section number, got ${bad.id}`;
  const nineteen = nodes.find((n) => n.id === 'PLAN-19');
  return nineteen
    ? null
    : `expected PLAN-19 (Safety Gates), got ${nodes.map((n) => n.id).join(', ')}`;
});

// ── detect ────────────────────────────────────────────────────────────────────────────

scenario(
  19,
  'detect: a blocker that fires "repeatedly" (2+ distinct batches) and each later integrates without incident is FIRED',
  () => {
    const adrs = [
      node({ id: 'ADR-0002', kind: 'settled', detection: 'see .artifacts/telemetry/lanes.jsonl' }),
    ];
    const events = [
      {
        ts: '2026-08-17T00:00:00Z',
        batch_id: 'b1',
        event: 'decide',
        eligible: false,
        blockers: ['R6'],
      },
      {
        ts: '2026-08-17T01:00:00Z',
        batch_id: 'b1',
        event: 'integration-gate',
        ok: true,
        violations: 0,
      },
      {
        ts: '2026-08-17T02:00:00Z',
        batch_id: 'b1b',
        event: 'decide',
        eligible: false,
        blockers: ['R6'],
      },
      { ts: '2026-08-17T03:00:00Z', batch_id: 'b1b', event: 'lane-gate', ok: true, violations: 0 },
    ];
    const found = detect(adrs, events);
    return found.some((f) => f.rule === 'too-conservative' && f.detail.includes('R6'))
      ? null
      : `expected a too-conservative finding for R6, got ${JSON.stringify(found)}`;
  },
);

scenario(
  19.5,
  'detect: a single clean run behind a blocker is one data point, not "repeatedly" — not FIRED',
  () => {
    const adrs = [
      node({ id: 'ADR-0002', kind: 'settled', detection: 'see .artifacts/telemetry/lanes.jsonl' }),
    ];
    const events = [
      {
        ts: '2026-08-17T00:00:00Z',
        batch_id: 'b1',
        event: 'decide',
        eligible: false,
        blockers: ['R6'],
      },
      {
        ts: '2026-08-17T01:00:00Z',
        batch_id: 'b1',
        event: 'integration-gate',
        ok: true,
        violations: 0,
      },
    ];
    const found = detect(adrs, events);
    return found.length === 0
      ? null
      : `expected no finding from a single clean run, got ${JSON.stringify(found)} — ADR 0002 says "fires repeatedly"`;
  },
);

scenario(
  20,
  'detect: eligible:true followed by a failure is FIRED as not-conservative-enough',
  () => {
    const adrs = [
      node({ id: 'ADR-0002', kind: 'settled', detection: 'see .artifacts/telemetry/lanes.jsonl' }),
    ];
    const events = [
      { ts: '2026-08-17T00:00:00Z', batch_id: 'b2', event: 'decide', eligible: true, blockers: [] },
      {
        ts: '2026-08-17T01:00:00Z',
        batch_id: 'b2',
        event: 'integration-gate',
        ok: false,
        violations: 1,
      },
    ];
    const found = detect(adrs, events);
    return found.some((f) => f.rule === 'not-conservative-enough')
      ? null
      : `expected a not-conservative-enough finding, got ${JSON.stringify(found)}`;
  },
);

scenario(21, 'detect: a clean batch history reports nothing', () => {
  const adrs = [
    node({ id: 'ADR-0002', kind: 'settled', detection: 'see .artifacts/telemetry/lanes.jsonl' }),
  ];
  const events = [
    {
      ts: '2026-08-17T00:00:00Z',
      batch_id: 'b3',
      event: 'decide',
      eligible: false,
      blockers: ['R1'],
    },
    { ts: '2026-08-17T01:00:00Z', batch_id: 'b3', event: 'lane-gate', ok: false, violations: 3 },
  ];
  const found = detect(adrs, events);
  return found.length === 0 ? null : `expected no findings, got ${JSON.stringify(found)}`;
});

scenario(
  22,
  'detect: an ADR whose Detection never mentions lanes.jsonl is skipped, not guessed at',
  () => {
    const adrs = [
      node({ id: 'ADR-0003', kind: 'settled', detection: 'read the code and think about it' }),
    ];
    const events = [
      {
        ts: '2026-08-17T00:00:00Z',
        batch_id: 'b4',
        event: 'decide',
        eligible: false,
        blockers: ['R1'],
      },
    ];
    const found = detect(adrs, events);
    return found.length === 0
      ? null
      : `expected no findings for a non-telemetry ADR, got ${JSON.stringify(found)}`;
  },
);

scenario(
  23,
  'detect against the live repository reports zero fired triggers on a clean tree',
  () => {
    const index = build();
    const settled = index.nodes.filter((n) => n.kind === 'settled');
    const found = detect(settled, loadLaneEvents());
    return found.length === 0
      ? null
      : `expected zero fired triggers, got ${JSON.stringify(found)} — a real Detection clause may have fired; verify before assuming a bug`;
  },
);

// ── open / route ──────────────────────────────────────────────────────────────────────

scenario(24, 'open() filters to status: open only', () => {
  const nodes = [node({ id: 'A', status: 'open' }), node({ id: 'B', status: 'answered' })];
  const found = open(nodes);
  return found.length === 1 && found[0]?.id === 'A'
    ? null
    : `expected only A, got ${found.map((n) => n.id).join(', ')}`;
});

scenario(25, 'route() always prints all four exclusion tests, never picks for the caller', () => {
  const r = route('does this block a deliverable');
  return r.tests.length === 4 ? null : `expected 4 exclusion tests, got ${r.tests.length}`;
});

// ── report ────────────────────────────────────────────────────────────────────────────

function report(): number {
  const failed = results.filter((r) => !r.pass);
  console.log('\ndecision-index scenarios\n');
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

if (isDirectRun()) process.exit(report());
