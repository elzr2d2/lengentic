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

// Later tasks extend these imports: Task 2 adds `execSync` (node:child_process), `dirname`,
// `resolve`, `fileURLToPath` and `basename`; Task 4 adds `readFileSync`, `writeFileSync`,
// `join`, `relative`, `classify`, `corpus`, `resolveTarget`, `walkMarkdown` from '../kb.ts' and
// `import type { Graph } from '../oracle.ts'`.

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
