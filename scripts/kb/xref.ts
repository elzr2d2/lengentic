/**
 * Cross-reference checker. Design: docs/specs/2026-08-18-cross-reference-checker.md as
 * revised by docs/specs/2026-09-01-cross-reference-checker-plan.md.
 *
 *   A  a block naming a packet id and a phase/segment must name the node's own
 *   B  a graph node's title/note citing a §NN from the other segment must label it
 *   C  a `PATH:LINE` citation must resolve; a bound one must still contain its fragment
 *   P  the §→segment partition in graph.json is complete
 *
 * Pure functions take text and a Graph. Only `sources()`, `cli()` and the git helpers touch
 * the disk. Imports from oracle.ts are type-only: oracle.ts imports this file at runtime.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify, corpus, resolveTarget, walkMarkdown } from '../kb.ts';
import type { Graph } from '../oracle.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GRAPH = 'scripts/oracle/graph.json';

// ── blocks ────────────────────────────────────────────────────────────────────────────

/** One assertion unit: a paragraph, a list item, a table row, a heading, or a fenced block. */
export interface Block {
  line: number;
  endLine: number;
  text: string;
  fenced: boolean;
}

const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^#{1,6}\s/;
const TABLE_ROW = /^\s*\|/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s/;

/**
 * Block-scoped, not line-scoped: this corpus is hard-wrapped at 100 columns, so a physical
 * line is formatting. A heading and a table row are each one unit; a list item starts a new
 * unit; a fenced block is one unit and is flagged so checks can skip code samples.
 */
export function blocksOf(text: string): Block[] {
  const lines = text.split(/\r?\n/);
  const out: Block[] = [];
  let cur: string[] = [];
  let start = 0;
  let fenced = false;

  const flush = (end: number, isFence = false): void => {
    if (cur.length > 0 && cur.join('').trim() !== '') {
      out.push({ line: start + 1, endLine: end, text: cur.join('\n'), fenced: isFence });
    }
    cur = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i] ?? '';
    if (FENCE.test(l)) {
      if (!fenced) {
        flush(i);
        start = i;
        cur.push(l);
        fenced = true;
      } else {
        cur.push(l);
        fenced = false;
        flush(i + 1, true);
      }
      continue;
    }
    if (fenced) {
      cur.push(l);
      continue;
    }
    if (l.trim() === '') {
      flush(i);
      continue;
    }
    if (HEADING.test(l) || TABLE_ROW.test(l)) {
      flush(i);
      start = i;
      cur.push(l);
      flush(i + 1);
      continue;
    }
    if (LIST_ITEM.test(l) && cur.length > 0) {
      flush(i);
    }
    if (cur.length === 0) start = i;
    cur.push(l);
  }
  flush(lines.length, fenced);
  return out;
}

export function blockAt(blocks: Block[], line: number): Block | null {
  return blocks.find((b) => b.line <= line && line <= b.endLine) ?? null;
}

/** Formatting-insensitive comparison. Both sides go through this, so what it drops is moot. */
export function normalize(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/[`*_>|#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function lineOfIndex(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

// ── citations ─────────────────────────────────────────────────────────────────────────

export interface Citation {
  raw: string;
  path: string;
  line: number;
  endLine: number;
  commit: string | null;
  fragment: string | null;
  /** offset of the whole citation in the source text */
  index: number;
  /** offset and length of `LINE[-LINE]`, so --fix can rewrite exactly that */
  numberIndex: number;
  numberLength: number;
}

const CORE =
  /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.(?:md|ts|tsx|json|js|mjs|cjs|yml|yaml|prisma)):(\d+)(?:-(\d+))?(?:@([0-9a-f]{7,40}))?/g;
// Tightened from the plan's first draft: after the closing backtick only `\s?\(?\s?` is
// allowed (no `)`), else "not bound: (`a.md:3`) "quoted prose later"" parses as bound.
// Tightened again: the closing quote must match the class of the opener. A single class for
// both let `aggregate.ts:100's blended rate … sides."` open on the possessive apostrophe and
// close on an unrelated later `"`. The fragment then begins with a lone `s` — the tell.
const TAIL = /^`?\s?\(?\s?(?:["“]([^"'”’\n]{12,240})["”]|['‘]([^"'”’\n]{12,240})['’])/;

export function parseCitations(text: string): Citation[] {
  const out: Citation[] = [];
  for (const m of text.matchAll(CORE)) {
    const index = m.index ?? 0;
    const path = m[1] ?? '';
    const lineText = m[2] ?? '0';
    const endText = m[3];
    const tail = TAIL.exec(text.slice(index + m[0].length, index + m[0].length + 260));
    const line = Number(lineText);
    out.push({
      raw: m[0],
      path,
      line,
      endLine: endText ? Number(endText) : line,
      commit: m[4] ?? null,
      fragment: tail?.[1] ?? tail?.[2] ?? null,
      index,
      numberIndex: index + path.length + 1,
      numberLength: lineText.length + (endText ? 1 + endText.length : 0),
    });
  }
  return out;
}

export type Resolution =
  { kind: 'ok'; file: string } | { kind: 'missing' } | { kind: 'ambiguous'; candidates: string[] };

/** Repo-relative first; else a unique basename among tracked files. Ambiguity is a finding. */
export function resolvePath(path: string, tracked: string[]): Resolution {
  const p = path.replace(/^\.\//, '').replace(/\\/g, '/');
  if (tracked.includes(p)) return { kind: 'ok', file: p };
  const suffix = tracked.filter((f) => f.endsWith(`/${p}`));
  const pool = suffix.length > 0 ? suffix : tracked.filter((f) => basename(f) === basename(p));
  if (pool.length === 1) return { kind: 'ok', file: pool[0] ?? p };
  if (pool.length === 0) return { kind: 'missing' };
  return { kind: 'ambiguous', candidates: pool };
}

let trackedCache: string[] | null = null;
export function trackedFiles(): string[] {
  if (trackedCache === null) {
    trackedCache = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter((f) => f !== '');
  }
  return trackedCache;
}

/**
 * Which of these repo-relative paths git ignores (`.artifacts/**`, `dist/**`,
 * `.claude/*.local.md`, …) — one `git check-ignore --stdin` call for the whole batch, never
 * one per citation. `git check-ignore` exits 1 (throwing from execSync) when none of the
 * input paths match any pattern; its stdout on that path is still the correct, empty answer.
 */
export function gitIgnored(paths: string[]): Set<string> {
  const uniq = [...new Set(paths)];
  if (uniq.length === 0) return new Set();
  try {
    const out = execSync('git check-ignore --stdin', {
      cwd: ROOT,
      input: uniq.join('\n'),
      encoding: 'utf8',
    });
    return new Set(out.split(/\r?\n/).filter((l) => l !== ''));
  } catch (e: unknown) {
    const out = (e as { stdout?: string }).stdout ?? '';
    return new Set(out.split(/\r?\n/).filter((l) => l !== ''));
  }
}

// ── findings ──────────────────────────────────────────────────────────────────────────

export type Severity = 'RED' | 'WARN';

export interface Finding {
  check: 'A' | 'B' | 'C' | 'P';
  severity: Severity;
  file: string;
  line: number;
  message: string;
  /** Check C: a bound citation whose fragment moved — `--fix` rewrites LINE[-LINE] to this. */
  fix?: { citation: Citation; line: number; endLine: number };
}

const finding = (
  check: Finding['check'],
  severity: Severity,
  file: string,
  line: number,
  message: string,
): Finding => ({ check, severity, file, line, message });

// ── exemptions that live in the document ──────────────────────────────────────────────

/** 7–40 hex chars with at least one digit and one letter: a commit, never an English word. */
const COMMITISH = /(?<![\w])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w])/;
const IGNORE = /<!--\s*xref-ignore:\s*([^>]*?)\s*-->/;

export function ignoreReason(blockText: string): string | null {
  const m = IGNORE.exec(blockText);
  if (!m) return null;
  const reason = (m[1] ?? '').trim();
  return reason.length >= 20 ? reason : null;
}

export function hasIgnoreMarker(blockText: string): boolean {
  return IGNORE.test(blockText);
}

export function isHistorical(blockText: string): boolean {
  return COMMITISH.test(blockText) || ignoreReason(blockText) !== null;
}

// ── check C ───────────────────────────────────────────────────────────────────────────

export interface CheckCInput {
  file: string;
  text: string;
  tracked: string[];
  readTarget: (file: string) => string | null;
  /**
   * A citation whose resolved path git ignores by design (`.artifacts/**`, `dist/**`,
   * `.claude/*.local.md`) is never RED — `trackedFiles()` can never contain it, so it would
   * be permanently unresolvable regardless of whether the cited line is accurate. Defaults to
   * "nothing is ignored" so existing callers that omit it are unaffected.
   */
  isIgnored?: (path: string) => boolean;
}

/**
 * A JSON source has no blank lines, so `blocksOf` would make it one block and a commit hash
 * in any note would exempt every citation in the file. One line, one block, for JSON.
 */
export function linesAsBlocks(text: string): Block[] {
  return text
    .split(/\r?\n/)
    .map((l, i) => ({ line: i + 1, endLine: i + 1, text: l, fenced: false }))
    .filter((b) => b.text.trim() !== '');
}

export function checkC(input: CheckCInput, severity: Severity): Finding[] {
  const out: Finding[] = [];
  const srcBlocks = input.file.endsWith('.json') ? linesAsBlocks(input.text) : blocksOf(input.text);
  const targetBlocks = new Map<string, Block[]>();
  const isIgnored = input.isIgnored ?? ((): boolean => false);

  for (const c of parseCitations(input.text)) {
    if (c.commit !== null) continue;
    const at = lineOfIndex(input.text, c.index);
    const holder = blockAt(srcBlocks, at);
    if (holder && isHistorical(holder.text)) continue;

    const r = resolvePath(c.path, input.tracked);
    const p = c.path.replace(/^\.\//, '').replace(/\\/g, '/');
    if (r.kind === 'missing') {
      if (isIgnored(p)) continue;
      out.push(finding('C', severity, input.file, at, `${c.raw}: file is not tracked`));
      continue;
    }
    if (r.kind === 'ambiguous') {
      if (isIgnored(p)) continue;
      out.push(
        finding('C', severity, input.file, at, `${c.raw}: ambiguous — ${r.candidates.join(', ')}`),
      );
      continue;
    }
    const target = input.readTarget(r.file);
    if (target === null) {
      out.push(finding('C', severity, input.file, at, `${c.raw}: ${r.file} is unreadable`));
      continue;
    }
    const total = target.split(/\r?\n/).length;
    if (c.endLine > total) {
      out.push(finding('C', severity, input.file, at, `${c.raw}: ${r.file} has ${total} lines`));
      continue;
    }
    if (c.fragment === null) continue; // bare: existence is the whole rule

    let blocks = targetBlocks.get(r.file);
    if (!blocks) {
      blocks = blocksOf(target);
      targetBlocks.set(r.file, blocks);
    }
    const want = normalize(c.fragment);
    const covering = blocks.filter((b) => b.endLine >= c.line && b.line <= c.endLine);
    if (covering.some((b) => normalize(b.text).includes(want))) continue;

    const elsewhere = blocks.filter((b) => normalize(b.text).includes(want));
    if (elsewhere.length === 1) {
      const b = elsewhere[0] as Block;
      out.push({
        ...finding(
          'C',
          severity,
          input.file,
          at,
          `${c.raw}: fragment moved to ${r.file}:${b.line} — run --fix`,
        ),
        fix: { citation: c, line: b.line, endLine: c.line === c.endLine ? b.line : b.endLine },
      });
      continue;
    }
    out.push(
      finding(
        'C',
        severity,
        input.file,
        at,
        elsewhere.length === 0
          ? `${c.raw}: fragment "${c.fragment}" is no longer in ${r.file}`
          : `${c.raw}: fragment is in ${elsewhere.length} blocks of ${r.file} — bind a longer one`,
      ),
    );
  }
  return out;
}

/** Rewrites every repairable citation in one source text, last offset first. */
export function applyFixes(text: string, findings: Finding[]): { text: string; applied: number } {
  const fixes = findings
    .filter((f): f is Finding & { fix: NonNullable<Finding['fix']> } => f.fix !== undefined)
    .sort((a, b) => b.fix.citation.numberIndex - a.fix.citation.numberIndex);
  let out = text;
  for (const f of fixes) {
    const c = f.fix.citation;
    const replacement =
      f.fix.line === f.fix.endLine ? `${f.fix.line}` : `${f.fix.line}-${f.fix.endLine}`;
    out = out.slice(0, c.numberIndex) + replacement + out.slice(c.numberIndex + c.numberLength);
  }
  return { text: out, applied: fixes.length };
}

// ── sources ───────────────────────────────────────────────────────────────────────────

export type Mode = 'red' | 'report' | 'skip';

export function modeOf(file: string): Mode {
  const f = file.replace(/\\/g, '/');
  const s = classify(f);
  if (s === 'historical') return 'skip';
  if (s === 'generated' || f === 'BACKLOG.md' || f === '.claude/autopilot.local.md')
    return 'report';
  return 'red';
}

export interface Source {
  file: string;
  text: string;
  mode: Mode;
}

/** Every tracked markdown file the kb walks, plus the graph — its titles and notes are briefs. */
export function sources(): Source[] {
  const tracked = new Set(trackedFiles());
  const out: Source[] = [];
  for (const abs of walkMarkdown()) {
    const file = relative(ROOT, abs).replace(/\\/g, '/');
    if (!tracked.has(file)) continue;
    const mode = modeOf(file);
    if (mode === 'skip') continue;
    out.push({ file, text: readFileSync(abs, 'utf8'), mode });
  }
  out.push({ file: GRAPH, text: readFileSync(join(ROOT, GRAPH), 'utf8'), mode: 'red' });
  return out;
}

export function readTracked(file: string): string | null {
  try {
    return readFileSync(join(ROOT, file), 'utf8');
  } catch {
    return null;
  }
}

/** `§18` exists in the plan iff kb resolves it to a chunk of `planRef`. */
export function sectionExistsLive(graph: Graph, section: string): boolean {
  return resolveTarget(corpus(), `§${section}`).some((c) => c.file === graph.planRef);
}

// ── segments ──────────────────────────────────────────────────────────────────────────

export const SECTION = /§(\d+(?:\.\d+)?)/g;

export function segmentOf(id: string, graph: Graph): string | null {
  for (const [seg, ids] of Object.entries(graph.segments ?? {})) if (ids.includes(id)) return seg;
  return null;
}

export function segmentOfSection(section: string, graph: Graph): string | null {
  const top = section.split('.')[0] ?? section;
  for (const [seg, secs] of Object.entries(graph.segmentSections ?? {})) {
    if (secs.includes(top)) return seg;
  }
  return null;
}

/**
 * Once any phase is split, its partition must be complete: every segment has a row, every
 * mapped section exists in the plan exactly once in the table, and every section a segmented
 * node cites (title, note, slice manifest) is mapped. An incomplete partition is RED, so the
 * change that introduces a split owns finishing it.
 */
export function checkPartition(graph: Graph, sectionExists: (s: string) => boolean): Finding[] {
  const out: Finding[] = [];
  const segs = graph.segments ?? {};
  const table = graph.segmentSections ?? {};
  const red = (m: string): void => {
    out.push(finding('P', 'RED', GRAPH, 0, m));
  };

  for (const seg of Object.keys(segs))
    if (!table[seg]) red(`segmentSections has no entry for segment "${seg}"`);
  for (const seg of Object.keys(table))
    if (!segs[seg]) red(`segmentSections names "${seg}", which graph.segments does not define`);

  const owner = new Map<string, string>();
  for (const [seg, secs] of Object.entries(table)) {
    for (const s of secs) {
      if (owner.has(s)) red(`§${s} is mapped to both ${owner.get(s)} and ${seg}`);
      owner.set(s, seg);
      if (!sectionExists(s))
        red(`§${s} is mapped to ${seg} but is not a section of ${graph.planRef}`);
    }
  }

  for (const [seg, ids] of Object.entries(segs)) {
    for (const id of ids) {
      const n = graph.nodes.find((x) => x.id === id);
      if (!n) continue;
      const cited = new Set<string>();
      for (const m of `${n.title} ${n.note ?? ''}`.matchAll(SECTION))
        cited.add((m[1] ?? '').split('.')[0] ?? '');
      for (const s of graph.sections[id] ?? []) if (/^\d+$/.test(s)) cited.add(s);
      for (const s of cited)
        if (!owner.has(s)) red(`${id} (${seg}) cites §${s}, which segmentSections does not map`);
    }
  }
  return out;
}

export function checkA(
  _file: string,
  _text: string,
  _graph: Graph,
  _severity: Severity,
): Finding[] {
  return []; // filled in Task 7
}
export function checkB(_graph: Graph, _graphText: string): Finding[] {
  return []; // filled in Task 8
}

// ── run ───────────────────────────────────────────────────────────────────────────────

export const IGNORE_CAP = 5;

export interface RunInput {
  fix: boolean;
  graph: Graph;
  graphText: string;
  srcs: Source[];
  tracked: string[];
  readTarget: (file: string) => string | null;
  sectionExists: (section: string) => boolean;
  /** Which resolved citation paths git ignores by design — see `CheckCInput.isIgnored`. */
  isIgnored?: (path: string) => boolean;
  /** Called with the repaired text of each source that had fixes. */
  write?: (file: string, text: string) => void;
}

export interface RunResult {
  findings: Finding[];
  ignores: number;
  fixed: number;
  red: number;
}

export function run(input: RunInput): RunResult {
  const findings: Finding[] = [];
  let ignores = 0;
  let fixed = 0;

  findings.push(...checkPartition(input.graph, input.sectionExists));
  findings.push(...checkB(input.graph, input.graphText));

  for (const s of input.srcs) {
    const severity: Severity = s.mode === 'red' ? 'RED' : 'WARN';
    for (const b of blocksOf(s.text)) {
      if (!hasIgnoreMarker(b.text)) continue;
      if (ignoreReason(b.text) === null) {
        findings.push(
          finding('C', severity, s.file, b.line, 'xref-ignore without a reason of 20+ chars'),
        );
      } else ignores += 1;
    }
    // Check A is a rule about prose. The graph's briefs are Check B's domain, and pretty-printed
    // JSON has no blank lines — it would be one block naming every packet and every phase.
    if (s.file !== GRAPH) findings.push(...checkA(s.file, s.text, input.graph, severity));
    const c = checkC(
      {
        file: s.file,
        text: s.text,
        tracked: input.tracked,
        readTarget: input.readTarget,
        ...(input.isIgnored ? { isIgnored: input.isIgnored } : {}),
      },
      severity,
    );
    if (input.fix && c.some((f) => f.fix)) {
      const { text, applied } = applyFixes(s.text, c);
      input.write?.(s.file, text);
      fixed += applied;
      findings.push(...c.filter((f) => !f.fix));
    } else findings.push(...c);
  }
  if (ignores > IGNORE_CAP) {
    findings.push(
      finding(
        'C',
        'RED',
        '(corpus)',
        0,
        `${ignores} xref-ignore markers exceed the cap of ${IGNORE_CAP} — Check A is measuring the ignores, not the corpus`,
      ),
    );
  }
  const red = findings.filter((f) => f.severity === 'RED').length;
  return { findings, ignores, fixed, red };
}

export function render(r: RunResult): string {
  const out: string[] = [''];
  for (const f of r.findings.sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'RED' ? -1 : 1,
  )) {
    const tag = f.fix ? 'FIX ' : f.severity === 'RED' ? 'RED ' : 'WARN';
    out.push(`  ${tag}  ${f.check}  ${f.file}:${f.line}  ${f.message}`);
  }
  const warn = r.findings.length - r.red;
  out.push(
    '',
    `  xref: ${r.red} RED, ${warn} WARN, ${r.ignores} ignores (cap ${IGNORE_CAP})${r.fixed ? `, ${r.fixed} fixed` : ''}`,
    '',
  );
  return out.join('\n');
}

export function cli(argv: string[]): number {
  const fix = argv.includes('--fix');
  const json = argv.includes('--json');
  const graphText = readFileSync(join(ROOT, GRAPH), 'utf8');
  const graph = JSON.parse(graphText) as Graph;
  const srcs = sources();
  // One batched `git check-ignore` call for every citation path in the corpus, not one per
  // citation — see `gitIgnored`'s own note.
  const allPaths = srcs.flatMap((s) =>
    parseCitations(s.text).map((c) => c.path.replace(/^\.\//, '').replace(/\\/g, '/')),
  );
  const ignored = gitIgnored(allPaths);
  const result = run({
    fix,
    graph,
    graphText,
    srcs,
    tracked: trackedFiles(),
    readTarget: readTracked,
    sectionExists: (s) => sectionExistsLive(graph, s),
    isIgnored: (p) => ignored.has(p),
    write: (file, text) => writeFileSync(join(ROOT, file), text, 'utf8'),
  });
  console.log(json ? JSON.stringify(result, null, 2) : render(result));
  return result.red > 0 ? 1 : 0;
}

function isDirectRun(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return resolve(invoked).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) process.exit(cli(process.argv.slice(2)));
