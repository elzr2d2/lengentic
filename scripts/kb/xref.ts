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

// Later tasks extend these imports: Task 4 adds `readFileSync`, `writeFileSync`, `join`,
// `relative`, `classify`, `corpus`, `resolveTarget`, `walkMarkdown` from '../kb.ts' and
// `import type { Graph } from '../oracle.ts'`.

import { execSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
const TAIL = /^`?\s?\(?\s?["'“‘]([^"'”’\n]{12,240})["'”’]/;

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
      fragment: tail?.[1] ?? null,
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

  for (const c of parseCitations(input.text)) {
    if (c.commit !== null) continue;
    const at = lineOfIndex(input.text, c.index);
    const holder = blockAt(srcBlocks, at);
    if (holder && isHistorical(holder.text)) continue;

    const r = resolvePath(c.path, input.tracked);
    if (r.kind === 'missing') {
      out.push(finding('C', severity, input.file, at, `${c.raw}: file is not tracked`));
      continue;
    }
    if (r.kind === 'ambiguous') {
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
