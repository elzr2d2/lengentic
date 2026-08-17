/**
 * `pnpm decide` — a generated, read-only index over the six places a decision lives in this
 * repository, plus a CLI to query it.
 *
 * ## Why an index and not a store
 *
 * Decisions already live in six places — `docs/decisions/` (ADRs), `scripts/oracle/graph.json`
 * `decisions[]` (open decisions), `BACKLOG.md` (deferred ideas), `CONTEXT.md` (definitional
 * choices), `MVP_PLAN_V3.md` (contract sections) and `.artifacts/telemetry/lanes.jsonl`
 * (mechanical dispatch decisions). Nothing joins them, which is how ADR 0004 can overturn a
 * `BACKLOG.md` entry in prose with no edge recording it, and how `OD-3` can carry
 * `"answered": true` with no answer text anywhere.
 *
 * `pnpm decide` never writes a decision. It parses the six stores fresh on every invocation —
 * committing the index risks drift, and the corpus is small enough (~100 records, well under
 * 50k tokens) that a full parse costs nothing. Authoring stays exactly where it already was.
 *
 * ## The failure mode this invites
 *
 * A loose match that answers "already decided" silences a question that should have been
 * asked. Three rules, enforced by the negative fixture suite in `scripts/decide/selftest.ts`:
 *
 *   1. `NOVEL` is the default. Below the confidence floor, or when the only candidate has no
 *      recoverable answer text, return `NOVEL`. Unknown counts as false.
 *   2. Citations, never paraphrase. Every hit carries `file:line` and the verbatim source line.
 *   3. A node with `status: answered` and no answer text anywhere (the literal shape `OD-1`
 *      through `OD-6` are in today, per `scripts/oracle/graph.json`) is never surfaced as a
 *      confident answer. Neither is a superseded record.
 *
 * ## Scope not taken on
 *
 * `.artifacts/` is entirely gitignored (`.gitignore`), so a citation into
 * `.artifacts/evidence/**` is unreachable from a fresh clone. `cites-evidence` edges are not
 * built for that reason — `BACKLOG.md` "the gitignored-evidence question" blocks them
 * specifically, not the rest of this tool. Telemetry (`.artifacts/telemetry/lanes.jsonl`) is
 * read as a live, best-effort local signal — its absence is not a parse failure, it is a
 * clean tree with nothing to report.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { corpus, frontmatter, glossary, tokenize } from './kb.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── node shape ────────────────────────────────────────────────────────────────────────

export type Kind = 'blocking' | 'settled' | 'deferred' | 'definitional' | 'contract' | 'mechanical';

export type Status = 'open' | 'answered' | { supersededBy: string } | { overturnedBy: string };

export interface DecisionNode {
  id: string;
  kind: Kind;
  question: string;
  /** What was chosen, flatly. `null` when no source carries the text — never fabricated. */
  answer: string | null;
  status: Status;
  decidedBy: string;
  decidedOn: string | null;
  learnedWrong: string | null;
  /** What would show this wrong, and who sees it. `null` when the source states none. */
  detection: string | null;
  /** `file:line` — every node cites, per the backfill rule in `docs/decisions/README.md`. */
  source: string;
}

export function statusLabel(s: Status): string {
  if (s === 'open') return 'open';
  if (s === 'answered') return 'answered';
  if ('supersededBy' in s) return `superseded-by ${s.supersededBy}`;
  return `overturned-by ${s.overturnedBy}`;
}

// ── store 1: ADRs (docs/decisions/*.md) ──────────────────────────────────────────────

const ADR_DIR = join(ROOT, 'docs/decisions');
const HEADINGS = ['Context', 'Decision', 'Consequences', 'Detection'] as const;

export class AdrParseError extends Error {}

function section(body: string, name: string): string | null {
  const re = new RegExp(`^##\\s+${name}\\s*$`, 'm');
  const m = re.exec(body);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = body.slice(start);
  const next = /^##\s+/m.exec(rest);
  return rest.slice(0, next ? next.index : undefined).trim();
}

function firstParagraph(text: string): string {
  return (text.split(/\r?\n\r?\n/)[0] ?? text).replace(/\s+/g, ' ').trim();
}

export function parseAdr(file: string, text: string): DecisionNode {
  const fm = frontmatter(text);
  const number = fm['number'];
  const title = fm['title'];
  const statusRaw = (fm['status'] ?? '').trim();
  if (!number || !title || statusRaw === '') {
    throw new AdrParseError(`${file}: missing number/title/status in front matter`);
  }
  const bodyStart = text.indexOf('\n---', 3);
  const body = bodyStart === -1 ? text : text.slice(bodyStart + 4);

  const missing = HEADINGS.filter((h) => section(body, h) === null);
  if (missing.length > 0) {
    throw new AdrParseError(`${file}: missing required heading(s): ${missing.join(', ')}`);
  }

  const decision = section(body, 'Decision') ?? '';
  const detection = section(body, 'Detection');
  const lines = text.split(/\r?\n/);
  const headingLine = lines.findIndex((l) => /^##\s+Decision\s*$/.test(l));
  // Cite the first line of the Decision body, not the heading itself — the heading repeats
  // the word "Decision" and quotes nothing a reader did not already know from the section list.
  let decisionLine = headingLine;
  if (headingLine >= 0) {
    for (let i = headingLine + 1; i < lines.length; i += 1) {
      if ((lines[i] ?? '').trim() !== '') {
        decisionLine = i;
        break;
      }
    }
  }

  const supersededMatch = /^superseded by\s+(\d{4})/i.exec(statusRaw);

  return {
    id: `ADR-${number}`,
    kind: 'settled',
    question: title,
    answer: firstParagraph(decision) || null,
    status: supersededMatch ? { supersededBy: `ADR-${supersededMatch[1]}` } : 'answered',
    decidedBy: 'human',
    decidedOn: fm['date'] ?? null,
    learnedWrong: null,
    detection: detection && detection !== '' ? detection : null,
    source: `${file}:${decisionLine >= 0 ? decisionLine + 1 : 1}`,
  };
}

export function loadAdrs(dir: string = ADR_DIR): DecisionNode[] {
  if (!existsSync(dir)) return [];
  const out: DecisionNode[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^\d{4}-.*\.md$/.test(name)) continue;
    const rel = `docs/decisions/${name}`;
    out.push(parseAdr(rel, readFileSync(join(dir, name), 'utf8')));
  }
  return out;
}

// ── store 2: oracle open decisions (scripts/oracle/graph.json decisions[]) ──────────

interface OracleDecision {
  id: string;
  question: string;
  answered: boolean;
  blocks?: string[];
  neededBy?: string;
}

const ORACLE_GRAPH = join(ROOT, 'scripts/oracle/graph.json');

export function loadOracleDecisions(path: string = ORACLE_GRAPH): DecisionNode[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { decisions?: OracleDecision[] };
  const rel = 'scripts/oracle/graph.json';
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/);
  return (raw.decisions ?? []).map((d) => {
    const lineIdx = lines.findIndex((l) => l.includes(`"id": "${d.id}"`));
    return {
      id: d.id,
      kind: 'blocking',
      question: d.question,
      // The graph never carries the text of the answer — only a boolean. This is the exact
      // bug named in `BACKLOG.md`: `answered: true` and nothing else. Never fabricated here.
      answer: null,
      status: d.answered ? 'answered' : 'open',
      decidedBy: 'human',
      decidedOn: null,
      learnedWrong: null,
      detection: (d.blocks ?? []).length > 0 ? `blocks: ${(d.blocks ?? []).join(', ')}` : null,
      source: `${rel}:${lineIdx >= 0 ? lineIdx + 1 : 1}`,
    } satisfies DecisionNode;
  });
}

interface OracleNode {
  id: string;
  note?: string;
  needs?: string[];
}

export function loadOracleNodes(path: string = ORACLE_GRAPH): OracleNode[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { nodes?: OracleNode[] };
  return raw.nodes ?? [];
}

// ── store 3: BACKLOG.md ──────────────────────────────────────────────────────────────

const BACKLOG_PATH = join(ROOT, 'BACKLOG.md');

function decidedByFrom(sourceText: string): string {
  const t = sourceText.toLowerCase();
  if (t.includes('council')) return 'council';
  const agent = /agent[:\s]+([a-z-]+)/.exec(t);
  if (agent?.[1]) return `agent:${agent[1]}`;
  const script = /`(pnpm [a-z0-9:._-]+)`/.exec(sourceText);
  if (script?.[1]) return `script:${script[1]}`;
  return 'human';
}

/** Grabs `**Label:** text…` up to the next blank line, wherever it sits in the paragraph. */
function labeled(body: string, label: string): string | null {
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?:\\n\\n|$)`, 'i');
  const m = re.exec(body);
  if (!m) return null;
  return (m[1] ?? '').replace(/\s+/g, ' ').trim();
}

export function parseBacklog(text: string): DecisionNode[] {
  const lines = text.split(/\r?\n/);
  const out: DecisionNode[] = [];
  let start = -1;
  let title = '';

  const flush = (endLine: number): void => {
    if (start === -1) return;
    const body = lines.slice(start, endLine).join('\n');
    const trigger = labeled(body, 'Trigger');
    const source = labeled(body, 'Source');
    const blNumber = start + 1;
    out.push({
      id: `BL-${blNumber}`,
      kind: 'deferred',
      question: title,
      answer:
        trigger === null
          ? null
          : /^none\b/i.test(trigger)
            ? `In force. ${trigger}`
            : `Deferred. Trigger: ${trigger}`,
      status: 'answered',
      decidedBy: source ? decidedByFrom(source) : 'human',
      decidedOn: null,
      learnedWrong: null,
      detection: trigger,
      source: `BACKLOG.md:${blNumber}`,
    });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const m = /^###\s+(.+?)\s*$/.exec(lines[i] ?? '');
    if (!m) continue;
    flush(i);
    title = m[1] ?? '';
    start = i + 1;
  }
  flush(lines.length);
  return out;
}

export function loadBacklog(path: string = BACKLOG_PATH): DecisionNode[] {
  if (!existsSync(path)) return [];
  return parseBacklog(readFileSync(path, 'utf8'));
}

// ── store 4: CONTEXT.md, via the kb glossary loader ──────────────────────────────────

export function loadContext(): DecisionNode[] {
  return glossary().map((e) => ({
    id: `CTX-${e.term.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`,
    kind: 'definitional',
    question: `what does "${e.term}" mean here?`,
    answer: e.definition || null,
    status: 'answered',
    decidedBy: 'human',
    decidedOn: null,
    learnedWrong: null,
    detection: null,
    source: `CONTEXT.md:${e.line}`,
  }));
}

// ── store 5: MVP_PLAN_V3.md, via the kb corpus/chunk loader ─────────────────────────

/** Top-level numbered sections only — `# 19. Safety Gates`, not `## 20.1`. The body is the
 *  contract; the answer is the heading, never a summary of prose that was not written as one. */
export function loadPlan(): DecisionNode[] {
  return corpus()
    .filter((c) => c.file === 'MVP_PLAN_V3.md' && c.level === 1 && c.section !== '')
    .map((c) => ({
      id: `PLAN-${c.section}`,
      kind: 'contract',
      question: `what does §${c.section} specify?`,
      answer: c.heading,
      status: 'answered',
      decidedBy: 'human',
      decidedOn: null,
      learnedWrong: null,
      detection: null,
      source: `MVP_PLAN_V3.md:${c.line}`,
    }));
}

// ── store 6: telemetry (.artifacts/telemetry/lanes.jsonl) ───────────────────────────

const LANES_JSONL = join(ROOT, '.artifacts/telemetry/lanes.jsonl');

interface LaneEvent {
  ts: string;
  batch_id: string;
  event: string;
  mode?: string;
  eligible?: boolean;
  blockers?: string[];
  ok?: boolean;
  violations?: number;
}

export function loadLaneEvents(path: string = LANES_JSONL): LaneEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as LaneEvent);
}

export function loadTelemetry(path: string = LANES_JSONL): DecisionNode[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const rawLines = raw.split(/\r?\n/);
  const out: DecisionNode[] = [];
  let lineNo = 0;
  for (const line of rawLines) {
    lineNo += 1;
    if (line.trim() === '') continue;
    const e = JSON.parse(line) as LaneEvent;
    if (e.event !== 'decide') continue;
    out.push({
      id: `LANE-${e.ts}`,
      kind: 'mechanical',
      question: `is ${e.batch_id} eligible for parallel dispatch?`,
      answer: `${e.mode ?? 'unknown'}; eligible=${String(e.eligible ?? false)}${
        (e.blockers ?? []).length > 0 ? `; blocked by ${(e.blockers ?? []).join(', ')}` : ''
      }`,
      status: 'answered',
      decidedBy: 'script:lanes',
      decidedOn: e.ts.slice(0, 10),
      learnedWrong: null,
      detection: null,
      source: `.artifacts/telemetry/lanes.jsonl:${lineNo}`,
    });
  }
  return out;
}

// ── the index ─────────────────────────────────────────────────────────────────────────

export interface DecideIndex {
  nodes: DecisionNode[];
  oracleNodes: OracleNode[];
}

export function build(): DecideIndex {
  const nodes = [
    ...loadOracleDecisions(),
    ...loadAdrs(),
    ...loadBacklog(),
    ...loadContext(),
    ...loadPlan(),
    ...loadTelemetry(),
  ];
  return { nodes, oracleNodes: loadOracleNodes() };
}

// ── ask: confidence floor, citations only, unknown counts as false ──────────────────

/** Below this, or with no distinct-token overlap over the floor ratio, the verdict is NOVEL. */
const MIN_SHARED_TOKENS = 2;
const MIN_OVERLAP_RATIO = 0.34;

export interface AskHit {
  node: DecisionNode;
  score: number;
  citation: string;
  line: string;
}

export type AskResult = { verdict: 'NOVEL' } | { verdict: 'FOUND'; hits: AskHit[] };

function nodeText(n: DecisionNode): string {
  return [n.question, n.answer ?? '', n.detection ?? ''].join(' ');
}

function sourceLine(source: string): string {
  const [file, lineStr] = source.split(':');
  const line = Number(lineStr);
  const abs = join(ROOT, file ?? '');
  if (!file || !Number.isFinite(line) || !existsSync(abs)) return '';
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  return (lines[line - 1] ?? '').trim();
}

/**
 * A node counts as "decided" only when it has recoverable answer text and is not superseded.
 * An `answered: true` node with no answer text (every `OD-*` node today) and a superseded ADR
 * both fail this — silently answering with either is the exact failure mode `ask` exists to
 * avoid.
 */
function isCitable(n: DecisionNode): boolean {
  if (n.answer === null) return false;
  if (typeof n.status === 'object' && 'supersededBy' in n.status) return false;
  return true;
}

export function ask(nodes: DecisionNode[], question: string): AskResult {
  const qt = [...new Set(tokenize(question))];
  if (qt.length === 0) return { verdict: 'NOVEL' };

  const hits: AskHit[] = [];
  for (const n of nodes) {
    if (!isCitable(n)) continue;
    const nt = new Set(tokenize(nodeText(n)));
    const shared = qt.filter((t) => nt.has(t));
    const overlap = shared.length / qt.length;
    if (shared.length < MIN_SHARED_TOKENS || overlap < MIN_OVERLAP_RATIO) continue;
    hits.push({
      node: n,
      score: shared.length + overlap,
      citation: n.source,
      line: sourceLine(n.source),
    });
  }

  if (hits.length === 0) return { verdict: 'NOVEL' };
  hits.sort((a, b) => b.score - a.score);
  return { verdict: 'FOUND', hits: hits.slice(0, 5) };
}

// ── why: every decision constraining a deliverable, in dependency order ─────────────

const ADR_REF = /(?:ADR|docs\/decisions\/)\s*[- ]?(\d{4})/g;

export function why(index: DecideIndex, taskId: string): DecisionNode[] {
  const out: DecisionNode[] = [];
  const seen = new Set<string>();
  const add = (n: DecisionNode | undefined): void => {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    out.push(n);
  };

  for (const n of index.nodes) {
    if (n.kind !== 'blocking') continue;
    const detection = n.detection ?? '';
    if (detection.includes(taskId)) add(n);
  }

  const chain = new Set<string>([taskId]);
  const node = index.oracleNodes.find((n) => n.id === taskId);
  for (const need of node?.needs ?? []) chain.add(need);

  for (const id of chain) {
    const on = index.oracleNodes.find((n) => n.id === id);
    if (!on?.note) continue;
    for (const m of on.note.matchAll(ADR_REF)) {
      add(index.nodes.find((n) => n.id === `ADR-${m[1]}`));
    }
  }

  return out;
}

// ── open: unanswered decisions and what each blocks ──────────────────────────────────

export function open(nodes: DecisionNode[]): DecisionNode[] {
  return nodes.filter((n) => n.status === 'open');
}

// ── route: the README's four exclusion tests, never auto-decided ────────────────────

const EXCLUSION_TESTS: Array<{ test: string; store: string; keywords: string[] }> = [
  {
    test: 'Does it block a deliverable?',
    store: 'scripts/oracle/graph.json decisions[] (OD-*)',
    keywords: ['block', 'blocks', 'blocking', 'gate', 'gates'],
  },
  {
    test: 'Is it a thing we might do later?',
    store: 'BACKLOG.md',
    keywords: ['later', 'defer', 'deferred', 'backlog', 'someday'],
  },
  {
    test: 'Is it what a word means here?',
    store: 'CONTEXT.md',
    keywords: ['mean', 'meaning', 'definition', 'term', 'means'],
  },
  {
    test: 'Is it a contract code must satisfy?',
    store: 'MVP_PLAN_V3.md',
    keywords: ['contract', 'must', 'spec', 'specify', 'specifies'],
  },
];

export interface RouteResult {
  suggestion: string | null;
  tests: typeof EXCLUSION_TESTS;
}

/** A heuristic pointer, never an authority — the four tests are always printed so a human
 *  answers them. `docs/decisions/` is suggested only when a caller states, unprompted, that
 *  the note fails all four — this function does not, and cannot, judge that itself. */
export function route(question: string): RouteResult {
  const qt = new Set(tokenize(question));
  for (const t of EXCLUSION_TESTS) {
    if (t.keywords.some((k) => qt.has(k))) return { suggestion: t.store, tests: EXCLUSION_TESTS };
  }
  return { suggestion: null, tests: EXCLUSION_TESTS };
}

// ── detect: telemetry-checkable Detection clauses ────────────────────────────────────

export interface DetectFinding {
  adrId: string;
  rule: string;
  detail: string;
}

/** "Fires repeatedly" (`docs/decisions/0002`'s own wording) means more than once. A single
 *  occurrence is one clean run, not a pattern. */
const REPEATEDLY = 2;

/**
 * Only Detection clauses that name `lanes.jsonl` are checked mechanically — the rest are
 * prose a human or `reflector` reads. Two generic rules, matching `docs/decisions/0002`'s
 * shape exactly and generalising to any future ADR that uses the same telemetry pattern:
 *
 *   1. too conservative  — a blocker fires on `decide` events for `REPEATEDLY`-or-more
 *      distinct batches, each of which later integrates (`ok: true`, zero violations)
 *      without incident. One clean run behind a blocker is not evidence the blocker is
 *      mis-specified; ADR 0002 says "fires repeatedly", and the check holds it to that word.
 *   2. not conservative enough — a batch is `eligible: true` and a later `lane-gate` or
 *      `integration-gate` event for the same batch reports a violation. Any single instance
 *      falsifies the gate directly, per ADR 0002 — no repetition required.
 */
export function detect(adrs: DecisionNode[], events: LaneEvent[]): DetectFinding[] {
  const findings: DetectFinding[] = [];
  const checkable = adrs.filter((a) => (a.detection ?? '').includes('lanes.jsonl'));
  if (checkable.length === 0) return findings;

  const decides = events.filter((e) => e.event === 'decide');
  const outcomes = events.filter((e) => e.event === 'integration-gate' || e.event === 'lane-gate');

  for (const adr of checkable) {
    const cleanBatchesByBlocker = new Map<string, Set<string>>();

    for (const d of decides) {
      const later = outcomes.filter((o) => o.batch_id === d.batch_id && o.ts > d.ts);
      if (d.eligible === false) {
        const succeeded = later.some((o) => o.ok === true && (o.violations ?? 0) === 0);
        if (succeeded) {
          for (const b of d.blockers ?? []) {
            const set = cleanBatchesByBlocker.get(b) ?? new Set<string>();
            set.add(d.batch_id);
            cleanBatchesByBlocker.set(b, set);
          }
        }
      } else if (d.eligible === true) {
        const failed = later.some((o) => o.ok === false || (o.violations ?? 0) > 0);
        if (failed) {
          findings.push({
            adrId: adr.id,
            rule: 'not-conservative-enough',
            detail: `${d.batch_id} was eligible:true and later failed`,
          });
        }
      }
    }

    for (const [blocker, batches] of cleanBatchesByBlocker) {
      if (batches.size < REPEATEDLY) continue;
      findings.push({
        adrId: adr.id,
        rule: 'too-conservative',
        detail: `${blocker} blocked ${batches.size} batches that each later integrated without incident: ${[...batches].join(', ')}`,
      });
    }
  }
  return findings;
}

// ── cli ───────────────────────────────────────────────────────────────────────────────

const USAGE = `usage: pnpm decide <command>

  ask "<question>"    already decided? cited hits, or NOVEL
  open                unanswered decisions
  route "<question>"  which store owns this — the four exclusion tests
  detect              which telemetry-checkable Detection clauses have fired  [exit 1 if any]
  why <task_id>        every decision constraining a deliverable
  build               regenerate the index and print counts per store        [exit 1 on parse failure]`;

function isDirectRun(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return resolve(invoked).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) main();

function main(): void {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'help';
  const args = argv.slice(1);

  switch (cmd) {
    case 'build': {
      try {
        const index = build();
        const byKind = new Map<Kind, number>();
        for (const n of index.nodes) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
        console.log(`\n  ${index.nodes.length} decisions indexed:`);
        for (const [k, c] of byKind) console.log(`    ${String(c).padStart(4)}  ${k}`);
        console.log('');
      } catch (e: unknown) {
        console.error(`parse failure: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
      break;
    }

    case 'ask': {
      const question = args.join(' ');
      if (question === '') {
        console.error('usage: pnpm decide ask "<question>"');
        process.exit(1);
      }
      const result = ask(build().nodes, question);
      console.log('');
      if (result.verdict === 'NOVEL') {
        console.log('  NOVEL — nothing in the six stores clears the confidence floor.');
      } else {
        for (const h of result.hits) {
          console.log(
            `  ${h.node.id}  [${h.node.kind}, ${statusLabel(h.node.status)}]  ${h.citation}`,
          );
          console.log(`      ${h.node.answer}`);
          console.log(`      > ${h.line}`);
          console.log('');
        }
      }
      console.log('');
      break;
    }

    case 'open': {
      const found = open(build().nodes);
      console.log('');
      if (found.length === 0) console.log('  no open decisions.');
      for (const n of found) console.log(`  ${n.id}  ${n.question}  (${n.source})`);
      console.log('');
      process.exit(found.length > 0 ? 1 : 0);
      break;
    }

    case 'route': {
      const question = args.join(' ');
      const r = route(question);
      console.log('');
      console.log('  the four exclusion tests — all must fail for docs/decisions/ (ADR):');
      for (const t of r.tests) console.log(`    - ${t.test}  ->  ${t.store}`);
      console.log('');
      console.log(
        r.suggestion
          ? `  heuristic pointer only: ${r.suggestion}`
          : '  no keyword pointer — answer the four tests yourself.',
      );
      console.log('');
      break;
    }

    case 'detect': {
      const index = build();
      const findings = detect(
        index.nodes.filter((n) => n.kind === 'settled'),
        loadLaneEvents(),
      );
      console.log('');
      if (findings.length === 0) console.log('  zero fired Detection triggers.');
      for (const f of findings) console.log(`  FIRED  ${f.adrId}  [${f.rule}]  ${f.detail}`);
      console.log('');
      process.exit(findings.length > 0 ? 1 : 0);
      break;
    }

    case 'why': {
      const taskId = args[0];
      if (!taskId) {
        console.error('usage: pnpm decide why <task_id>');
        process.exit(1);
      }
      const found = why(build(), taskId);
      console.log('');
      if (found.length === 0) console.log(`  no decision constrains ${taskId}.`);
      for (const n of found) console.log(`  ${n.id}  [${n.kind}]  ${n.question}  (${n.source})`);
      console.log('');
      break;
    }

    case 'help':
      console.log(USAGE);
      break;

    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(1);
  }
}
