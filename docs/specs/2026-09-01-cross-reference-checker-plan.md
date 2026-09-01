# Cross-reference checker — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: proposed 2026-09-01. Revises `docs/specs/2026-08-18-cross-reference-checker.md` per
`.artifacts/plans/xref-checker-review-2026-09-01.md`. Where the two disagree, this plan wins;
Task 11 folds the corrections back into the spec.

**Goal:** A deterministic checker that goes RED when a live cross-reference in the harness corpus
is wrong — a packet id restated with the wrong phase, a graph node citing a section from the
other sub-phase, or a `FILE:LINE` citation whose target moved — and that repairs the routine
case (a renumbered line) instead of training people to silence it.

**Architecture:** One new module `scripts/kb/xref.ts` of pure functions over text + `Graph`;
disk access only in `sources()` and `cli()`. Sub-phase comes from the `segments` that
`graph.json` already carries — no `subphase` field. A small `segmentSections` table in
`graph.json` maps `§NN` → segment. Wired into `pnpm check:kb` (CI + pre-commit), into
`pnpm oracle packet` (refuses a stale brief) and exposed as `pnpm kb xref [--fix]`.

**Tech Stack:** TypeScript under the root `tsconfig.json` (`scripts/**/*.ts`), run with `tsx`.
Selftests follow the `scripts/kb/selftest.ts` pattern (inline fixtures, `scenario()`, exit code).
No new dependencies.

## Global Constraints

- `pnpm gates` must keep passing with `.claude/` deleted; everything here lives in `scripts/`
  and is reached only from `check:kb`, `kb`, `oracle`, and `precommit.ts`.
- `scripts/kb/xref.ts` imports from `../oracle.ts` **type-only** (`import type`). `oracle.ts`
  imports `./kb/xref.ts` at runtime; a value import back would be a cycle.
- No LLM step, no embeddings, no hand-typed ledger, no suppression _list_: exemptions live in
  the document (a commit hash in the block, or an `xref-ignore` HTML comment whose reason text
  is at least 20 characters).
- Line width 100, prettier + eslint clean before every commit (`pnpm exec prettier --write`,
  `pnpm exec eslint`). Commit prefix `feat(harness):` / `fix(harness):` / `docs:`.
- Every "run it" step quotes real output. A fixture that stays green is a failed criterion.
- Evidence goes to `.artifacts/evidence/xref/` (not `second-brain/`).

## File structure

| File                                                        | Responsibility                                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `scripts/kb/xref.ts` (new)                                  | blocks, normalization, citation grammar, resolver, checks A/B/C/P, `--fix`, `run()`, `cli()`, `nodeFindings()` |
| `scripts/kb/xref-selftest.ts` (new)                         | scenarios; second half of `pnpm check:kb`                                                                      |
| `scripts/kb/xref-replay.ts` (new)                           | history replay → `.artifacts/evidence/xref/replay.md`                                                          |
| `scripts/kb.ts` (modify)                                    | `xref` subcommand + USAGE line                                                                                 |
| `scripts/oracle.ts` (modify)                                | `Graph.segmentSections`; `packet` refusal; `ready()` gating annotation                                         |
| `scripts/oracle/graph.json` (modify)                        | `segmentSections`; fix `p5.spike-deleted.note` citation                                                        |
| `scripts/precommit.ts` (modify)                             | run `pnpm kb xref` when a `.md` is staged                                                                      |
| `package.json` (modify)                                     | `check:kb` runs both selftests                                                                                 |
| `CLAUDE.md`, `BACKLOG.md` (modify)                          | bind/fix the four known drifted citations                                                                      |
| `docs/specs/2026-08-18-cross-reference-checker.md` (modify) | Task 11 corrections                                                                                            |

---

### Task 1: Blocks and normalization

**Files:**

- Create: `scripts/kb/xref.ts`
- Create: `scripts/kb/xref-selftest.ts`

**Interfaces:**

- Produces: `interface Block { line: number; endLine: number; text: string; fenced: boolean }`,
  `blocksOf(text: string): Block[]`, `blockAt(blocks: Block[], line: number): Block | null`,
  `normalize(s: string): string`, `lineOfIndex(text: string, index: number): number`.

- [ ] **Step 1: Write the selftest harness and the first scenarios**

`scripts/kb/xref-selftest.ts`:

```ts
/**
 * Scenarios for the cross-reference checker. Every scenario runs on inline fixture text and a
 * fixture graph, so the expected value comes from the fixture, not from what the repository
 * happens to say today. The two live-corpus scenarios at the end are claims about this repo.
 *
 *   pnpm check:kb      (or)     tsx scripts/kb/xref-selftest.ts
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { blocksOf, blockAt, normalize } from './xref.ts';

interface Result {
  n: number;
  name: string;
  pass: boolean;
  detail: string;
}
const results: Result[] = [];

/** A scenario returns `null` on pass, or the disagreement — expected AND actual, both. */
function scenario(n: number, name: string, fn: () => string | null): void {
  let detail: string | null;
  try {
    detail = fn();
  } catch (e: unknown) {
    detail = `threw: ${e instanceof Error ? e.message : String(e)}`;
  }
  results.push({ n, name, pass: detail === null, detail: detail ?? '' });
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────

const DOC = `# 19. Safety Gates

All five must pass. A gate that
wraps across lines is one block.

- first item, with a wrap
  that continues here
- second item

| a | b |
| - | - |
| 1 | 2 |

\`\`\`text
code p5.spike-deleted at the 5a gate
\`\`\`

Last paragraph.
`;

// ── blocks ────────────────────────────────────────────────────────────────────────────

scenario(
  1,
  'blocksOf: paragraph, list items, table rows, fence, heading are separate blocks',
  () => {
    const b = blocksOf(DOC);
    const got = b.map((x) => `${x.line}-${x.endLine}${x.fenced ? 'F' : ''}`).join(' ');
    const want = '1-1 3-4 6-7 8-8 10-10 11-11 12-12 14-16F 18-18';
    return got === want ? null : `expected ${want}, got ${got}`;
  },
);

scenario(2, 'blockAt finds the block covering a wrapped line', () => {
  const b = blockAt(blocksOf(DOC), 7);
  return b && b.line === 6 && /continues here/.test(b.text)
    ? null
    : `expected the first list item, got ${JSON.stringify(b)}`;
});

scenario(3, 'normalize strips formatting and collapses whitespace', () => {
  const got = normalize('owns deleting `spike/`   (**5b**),\n  *not* 5a <!-- x -->');
  const want = 'owns deleting spike/ (5b), not 5a';
  return got === want ? null : `expected "${want}", got "${got}"`;
});

// ── report ────────────────────────────────────────────────────────────────────────────

function report(): number {
  const failed = results.filter((r) => !r.pass);
  console.log('\ncross-reference scenarios\n');
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec tsx scripts/kb/xref-selftest.ts`
Expected: error `Cannot find module './xref.ts'` (or all three scenarios `threw:`).

- [ ] **Step 3: Write `scripts/kb/xref.ts` — blocks and normalization**

````ts
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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GRAPH = 'scripts/oracle/graph.json';

// Later tasks extend these imports: Task 2 adds `execSync` (node:child_process) and `basename`;
// Task 4 adds `readFileSync`, `writeFileSync`, `join`, `relative`, `classify`, `corpus`,
// `resolveTarget`, `walkMarkdown` from '../kb.ts' and `import type { Graph } from '../oracle.ts'`.

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
````

(`GRAPH` is first used in Task 3; if eslint flags it unused on this commit, add it in Task 3
instead.)

- [ ] **Step 4: Run the scenarios**

Run: `pnpm exec tsx scripts/kb/xref-selftest.ts`
Expected:

```
  PASS   1  blocksOf: paragraph, list items, table rows, fence, heading are separate blocks
  PASS   2  blockAt finds the block covering a wrapped line
  PASS   3  normalize strips formatting and collapses whitespace

  3/3 passed
```

- [ ] **Step 5: Lint, format, commit**

```bash
pnpm exec prettier --write scripts/kb/xref.ts scripts/kb/xref-selftest.ts
pnpm exec eslint scripts/kb/xref.ts scripts/kb/xref-selftest.ts
git add scripts/kb/xref.ts scripts/kb/xref-selftest.ts
git commit -m "feat(harness): xref — blocks and normalization"
```

---

### Task 2: Citation grammar and path resolution

**Files:**

- Modify: `scripts/kb/xref.ts`
- Modify: `scripts/kb/xref-selftest.ts`

**Interfaces:**

- Produces: `interface Citation { raw; path; line; endLine; commit: string | null; fragment: string | null; index; numberIndex; numberLength }`,
  `parseCitations(text): Citation[]`,
  `type Resolution = { kind: 'ok'; file } | { kind: 'missing' } | { kind: 'ambiguous'; candidates: string[] }`,
  `resolvePath(path, tracked: string[]): Resolution`, `trackedFiles(): string[]`.

Grammar (one form for markdown and JSON strings):

```
`PATH:LINE[-LINE][@COMMIT]`  ["fragment"]      fragment: 12–240 chars, "…" or '…' or “…”,
                                                at most `)`, one space and one `(` after the
                                                closing backtick; anything further is prose
```

- [ ] **Step 1: Add scenarios 4–6**

```ts
import { blocksOf, blockAt, normalize, parseCitations, resolvePath } from './xref.ts';

scenario(4, 'parseCitations: bare, range, bound (both quote styles), @commit, basename', () => {
  const text = [
    'see `MVP_PLAN_V3.md:2262` and `x/merge-rules.ts:56-60` for the rule.',
    'bound: `CLAUDE.md:291` "owns deleting spike/" and note.md:12 \'twelve chars ok\'',
    'historical `CLAUDE.md:278@8ce66d5`; not bound: (`a.md:3`) "quoted prose later"',
  ].join('\n');
  const got = parseCitations(text).map(
    (c) => `${c.path}:${c.line}-${c.endLine}${c.commit ? '@' : ''}${c.fragment ? 'B' : ''}`,
  );
  const want = [
    'MVP_PLAN_V3.md:2262-2262',
    'x/merge-rules.ts:56-60',
    'CLAUDE.md:291-291B',
    'note.md:12-12B',
    'CLAUDE.md:278-278@',
    'a.md:3-3',
  ];
  return got.join(' ') === want.join(' ')
    ? null
    : `expected ${want.join(' ')}, got ${got.join(' ')}`;
});

scenario(5, 'parseCitations records where the number sits, for --fix', () => {
  const text = 'x `docs/a.md:10-12` y';
  const c = parseCitations(text)[0];
  if (!c) return 'no citation parsed';
  const slice = text.slice(c.numberIndex, c.numberIndex + c.numberLength);
  return slice === '10-12' ? null : `expected "10-12", got "${slice}"`;
});

scenario(6, 'resolvePath: repo-relative, unique basename, ambiguous, missing', () => {
  const tracked = ['CLAUDE.md', 'a/merge-rules.ts', 'b/validator.md', 'c/validator.md'];
  const r = (p: string): string => {
    const x = resolvePath(p, tracked);
    return x.kind === 'ok' ? x.file : x.kind;
  };
  const got = [r('CLAUDE.md'), r('merge-rules.ts'), r('validator.md'), r('nope.md')].join(' ');
  const want = 'CLAUDE.md a/merge-rules.ts ambiguous missing';
  return got === want ? null : `expected ${want}, got ${got}`;
});
```

- [ ] **Step 2: Run, expect 4–6 to throw (`parseCitations` not exported)**

Run: `pnpm exec tsx scripts/kb/xref-selftest.ts`
Expected: `FAIL 4 … threw:` ×3, `3/6 passed`.

- [ ] **Step 3: Implement**

Append to `scripts/kb/xref.ts`:

```ts
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
const TAIL = /^`?\)?\s?\(?\s?["'“‘]([^"'”’\n]{12,240})["'”’]/;

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
```

Note the scenario-4 trap: `(`a.md:3`) "quoted prose later"` — TAIL allows `` ` `` then `)`
then a space then a quote, so that one **is** parsed bound by the regex above. That is wrong;
tighten:
after the closing backtick only `\s?\(?\s?` is allowed (no `)`). Use:
<!-- xref-ignore: a.md:3 above is scenario 4's literal fixture text, not a real file citation -->

```ts
const TAIL = /^`?\s?\(?\s?["'“‘]([^"'”’\n]{12,240})["'”’]/;
```

- [ ] **Step 4: Run, expect 6/6**

Run: `pnpm exec tsx scripts/kb/xref-selftest.ts`
Expected: `6/6 passed`.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write scripts/kb/xref.ts scripts/kb/xref-selftest.ts
pnpm exec eslint scripts/kb/xref.ts scripts/kb/xref-selftest.ts
git add scripts/kb/xref.ts scripts/kb/xref-selftest.ts
git commit -m "feat(harness): xref — citation grammar and path resolution"
```

---

### Task 3: Check C — bare, bound, historical, and `--fix`

**Files:**

- Modify: `scripts/kb/xref.ts`
- Modify: `scripts/kb/xref-selftest.ts`

**Interfaces:**

- Produces: `type Severity = 'RED' | 'WARN'`,
  `interface Finding { check: 'A' | 'B' | 'C' | 'P'; severity; file; line; message; fix?: { citation: Citation; line: number; endLine: number } }`,
  `isHistorical(blockText): boolean`, `ignoreReason(blockText): string | null`,
  `checkC(input: { file; text; tracked; readTarget: (file) => string | null }, severity): Finding[]`,
  `applyFixes(text, findings): { text; applied: number }`.

Rules:

- `@COMMIT` → skipped (historical by construction). Block containing a commit-ish
  (7–40 hex chars with at least one digit and one letter) or an `xref-ignore` marker → skipped.
- Bare → file resolves and `endLine ≤` line count.
- Bound → normalized fragment ⊂ normalized text of the block(s) covering `line..endLine`.
  Else, if exactly one block in the target contains it → finding with `fix`. Else RED.

- [ ] **Step 1: Scenarios 7–11 (FC, FC-bare, FC-fix, FC-hist, ignore reason)**

```ts
import {
  applyFixes,
  blocksOf,
  blockAt,
  checkC,
  ignoreReason,
  isHistorical,
  normalize,
  parseCitations,
  resolvePath,
} from './xref.ts';

const PLAN = `# PART III

- [ ] R4 and R5 both emit.
- [ ] \`spike/\` is deleted.

**Validation gate.** GREEN advances.
`;
const targets = (files: Record<string, string>) => (f: string) => files[f] ?? null;

scenario(7, 'FC: a bound citation whose fragment left the block is RED', () => {
  const src = 'owns deleting `spike/` (`MVP_PLAN_V3.md:3` "R1 and R2 both emit").';
  const f = checkC(
    {
      file: 'CLAUDE.md',
      text: src,
      tracked: ['MVP_PLAN_V3.md'],
      readTarget: targets({ 'MVP_PLAN_V3.md': PLAN }),
    },
    'RED',
  );
  return f.length === 1 && f[0]?.severity === 'RED' && /no longer in/.test(f[0].message)
    ? null
    : `expected one RED "no longer in", got ${JSON.stringify(f)}`;
});

scenario(8, 'FC-bare: the same citation without a fragment stays green', () => {
  const src = 'owns deleting `spike/` (`MVP_PLAN_V3.md:3`).';
  const f = checkC(
    {
      file: 'CLAUDE.md',
      text: src,
      tracked: ['MVP_PLAN_V3.md'],
      readTarget: targets({ 'MVP_PLAN_V3.md': PLAN }),
    },
    'RED',
  );
  return f.length === 0 ? null : `expected no finding, got ${JSON.stringify(f)}`;
});

scenario(
  9,
  'FC-fix: a fragment found in exactly one other block is repairable, and --fix rewrites',
  () => {
    const src = 'owns deleting `spike/` (`MVP_PLAN_V3.md:3` "spike/ is deleted").';
    const f = checkC(
      {
        file: 'CLAUDE.md',
        text: src,
        tracked: ['MVP_PLAN_V3.md'],
        readTarget: targets({ 'MVP_PLAN_V3.md': PLAN }),
      },
      'RED',
    );
    if (f.length !== 1 || !f[0]?.fix)
      return `expected one fixable finding, got ${JSON.stringify(f)}`;
    const { text, applied } = applyFixes(src, f);
    return applied === 1 && text.includes('`MVP_PLAN_V3.md:4` "spike/ is deleted"')
      ? null
      : `expected the line rewritten to 4, got ${text}`;
  },
);

scenario(
  10,
  'a block carrying a commit hash, or an @commit citation, is historical and skipped',
  () => {
    const src = [
      'At `8ce66d5` line 278 said `CLAUDE.md:999` "nothing about spike".',
      '',
      'And `CLAUDE.md:999@8ce66d5` too.',
    ].join('\n');
    const f = checkC(
      {
        file: 'spec.md',
        text: src,
        tracked: ['CLAUDE.md'],
        readTarget: targets({ 'CLAUDE.md': 'one line' }),
      },
      'RED',
    );
    const hist =
      isHistorical('defaced facade decade') === false && isHistorical('see 130c43a') === true;
    return f.length === 0 && hist
      ? null
      : `expected no findings and hex-word safety, got ${JSON.stringify(f)} ${hist}`;
  },
);

scenario(11, 'an xref-ignore needs a reason of at least 20 characters', () => {
  const ok = ignoreReason('x <!-- xref-ignore: restates the 08-18 contradiction on purpose -->');
  const short = ignoreReason('x <!-- xref-ignore: history -->');
  return ok !== null && short === null ? null : `expected reason/null, got ${ok}/${short}`;
});
```

- [ ] **Step 2: Run, expect 7–11 to throw**

Run: `pnpm exec tsx scripts/kb/xref-selftest.ts`
Expected: `6/11 passed`.

- [ ] **Step 3: Implement**

Append to `scripts/kb/xref.ts`:

```ts
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
```

- [ ] **Step 4: Run, expect 11/11**

Run: `pnpm exec tsx scripts/kb/xref-selftest.ts`
Expected: `11/11 passed`.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write scripts/kb/xref.ts scripts/kb/xref-selftest.ts
pnpm exec eslint scripts/kb/xref.ts scripts/kb/xref-selftest.ts
git add scripts/kb/xref.ts scripts/kb/xref-selftest.ts
git commit -m "feat(harness): xref — check C, historical blocks, --fix"
```

---

### Task 4: Sources, `run()`, `pnpm kb xref`, and the Check C precision record

**Files:**

- Modify: `scripts/kb/xref.ts`
- Modify: `scripts/kb.ts:646-656` (USAGE) and the `switch (cmd)` in `main()`
- Modify: `package.json` (`check:kb`)
- Create: `.artifacts/evidence/xref/precision-c.md`

**Interfaces:**

- Produces: `type Mode = 'red' | 'report' | 'skip'`, `modeOf(file): Mode`,
  `interface Source { file; text; mode }`, `sources(): Source[]`,
  `interface RunInput { fix; graph; graphText; srcs; tracked; readTarget; sectionExists }`,
  `interface RunResult { findings: Finding[]; ignores: number; fixed: number; red: number }`,
  `run(input): RunResult`, `render(result): string`, `cli(argv: string[]): number`.
- `run()` calls `checkA`/`checkB`/`checkPartition` which do not exist until Tasks 6–8: define
  them **as stubs returning `[]`** here, with a `// filled in Task N` comment, so `run()` is
  complete and Task 4 ships a working Check C. (This is the one allowed forward reference; the
  stubs are replaced, never left.)

Scoping (`modeOf`):

| Source                                                                                   | Mode                         |
| ---------------------------------------------------------------------------------------- | ---------------------------- |
| `classify()` = `historical`                                                              | `skip`                       |
| `classify()` = `generated` (`.artifacts/**`), `BACKLOG.md`, `.claude/autopilot.local.md` | `report` (WARN, never fails) |
| everything else tracked, plus `scripts/oracle/graph.json`                                | `red`                        |

- [ ] **Step 1: Implement sources, run, render, cli**

Append to `scripts/kb/xref.ts`:

```ts
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

// ── stubs replaced in Tasks 6–8 ───────────────────────────────────────────────────────

export function checkPartition(_graph: Graph, _sectionExists: (s: string) => boolean): Finding[] {
  return []; // filled in Task 6
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
      { file: s.file, text: s.text, tracked: input.tracked, readTarget: input.readTarget },
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
  const result = run({
    fix,
    graph,
    graphText,
    srcs: sources(),
    tracked: trackedFiles(),
    readTarget: readTracked,
    sectionExists: (s) => sectionExistsLive(graph, s),
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
```

- [ ] **Step 2: Wire `pnpm kb xref`**

In `scripts/kb.ts` USAGE, after the `stale` line add:

```
  xref              cross-reference check: packet/phase, §/segment, FILE:LINE   [--fix] [--json]
```

In `main()`'s `switch (cmd)`, before `case 'help':`:

```ts
    case 'xref': {
      // Dynamic on purpose: xref imports this file, and a static import back would be a cycle.
      void import('./kb/xref.ts').then((m) => process.exit(m.cli(argv)));
      break;
    }
```

In `package.json`:

```json
"check:kb": "tsx scripts/kb/selftest.ts && tsx scripts/kb/xref-selftest.ts",
```

- [ ] **Step 3: Run over the real tree and capture**

Run: `pnpm kb xref | tee .artifacts/evidence/xref/run-c-initial.txt` (create the directory first:
`mkdir -p .artifacts/evidence/xref`)
Expected (numbers are the review's measurement at `130c43a`; yours will differ slightly): zero
RED from bound citations (the corpus has none in the grammar yet), ~41 `WARN C … file is not
tracked` / `ambiguous` in `BACKLOG.md`, and — because `CLAUDE.md:291` is bare — **no** finding
on the citation that motivated the spec. That absence is the argument for Task 5.

- [ ] **Step 4: Write the precision record**

`.artifacts/evidence/xref/precision-c.md` — paste the run verbatim under `## Run`, then a
table with one row per finding:

```markdown
# Check C precision — initial run

Commit: <git rev-parse --short HEAD> Command: pnpm kb xref

## Run

<verbatim output>

## Verdicts

| finding (file:line — message) | verdict: real defect / false positive / report-only noise | action |
| ----------------------------- | --------------------------------------------------------- | ------ |
```

Every row gets a verdict. A row you cannot judge is `unknown` and is listed under
`## Unverified` — not omitted.

- [ ] **Step 5: Run both selftests, then commit**

Run: `pnpm check:kb`
Expected: `18/18 passed` then `11/11 passed`, exit 0.

```bash
pnpm exec prettier --write scripts/kb/xref.ts scripts/kb.ts package.json
pnpm exec eslint scripts/kb/xref.ts scripts/kb.ts
git add scripts/kb/xref.ts scripts/kb.ts package.json .artifacts/evidence/xref/
git commit -m "feat(harness): pnpm kb xref — check C over the corpus, precision recorded"
```

---

### Task 5: Migration — bind the citations worth binding, fix the four known drifts

**Files:**

- Modify: `CLAUDE.md:291`
- Modify: `BACKLOG.md:1115-1116`, `BACKLOG.md:1139`
- Modify: `scripts/oracle/graph.json` (`p5.spike-deleted.note`)
- Modify: whichever files `grep` lists in Step 3

**Interfaces:** none (data only).

- [ ] **Step 1: Fix the known four**

`CLAUDE.md:291` — replace

```
is waves 4–6, stays after Phase 4, and owns deleting `spike/` (`MVP_PLAN_V3.md:2236`). The
```

with

```
is waves 4–6, stays after Phase 4, and owns deleting `spike/` (`MVP_PLAN_V3.md:2262`
"spike/ is deleted"). The
```

(re-wrap the paragraph to 100 columns; the fragment may sit on the next line — TAIL allows one
whitespace character, and a newline is one.)

`BACKLOG.md:1115-1116` — find the current line of the heading:
`grep -n "The three defects, honestly classified" docs/specs/2026-08-18-cross-reference-checker.md`
(68 at `130c43a`) and rewrite to

```
**Source:** `docs/specs/2026-08-18-cross-reference-checker.md:68` "The three defects, honestly
classified", which classifies it out of scope and owes this entry (spec implementation step 10).
```

`BACKLOG.md:1139` — `grep -n "The product half of the original request" docs/specs/2026-08-18-cross-reference-checker.md`
(29 at `130c43a`) and rewrite to

```
Recorded in `docs/specs/2026-08-18-cross-reference-checker.md:29` "The product half of the
original request".
```

`scripts/oracle/graph.json`, node `p5.spike-deleted`, `note` — replace the opening

```
MVP_PLAN_V3.md:2236 puts this in the 5b Definition of Done, and .artifacts/plans/remaining-roadmap.md:369-374 assigns it to wave 4: 'here, not earlier. Until this packet it is the independent cross-check on 5a's numbers.'
```

with

```
MVP_PLAN_V3.md:2262 'spike/ is deleted' puts this in the 5b Definition of Done, and .artifacts/plans/remaining-roadmap.md:375 'spike/ is deleted here, not earlier' assigns it to wave 4.
```

- [ ] **Step 2: Prove the checker sees the bound forms**

Run: `pnpm kb xref`
Expected: 0 RED. Then break one on purpose — edit `CLAUDE.md` to `:2261` — run again:

```
  FIX   C  CLAUDE.md:291  MVP_PLAN_V3.md:2261: fragment moved to MVP_PLAN_V3.md:2262 — run --fix
```

Run `pnpm kb xref --fix`, expect `1 fixed` and `git diff CLAUDE.md` empty.

- [ ] **Step 3: Bind the rest that already carry a quote**

List candidates:
`grep -rnE '\.md:[0-9]+(-[0-9]+)?`?[^`]{0,40}["“]' --include='*.md' CLAUDE.md CONTEXT.md docs .claude MVP_PLAN_V3.md`
For each hit where the quote **is** the target text, move the quote to directly after the
citation (bound form). Where the quote is commentary, leave it bare. Record each decision as a
row in `.artifacts/evidence/xref/precision-c.md` under `## Migration`.

- [ ] **Step 4: Commit**

```bash
pnpm kb xref            # must print 0 RED
pnpm check:flow         # graph.json changed; segments unaffected, prove it
git add CLAUDE.md BACKLOG.md scripts/oracle/graph.json docs .claude .artifacts/evidence/xref/precision-c.md
git commit -m "docs: bind the citations that carry a fragment; fix four drifted line numbers"
```

---

### Task 6: `segmentSections` and the partition check

**Files:**

- Modify: `scripts/oracle.ts:79-89` (`Graph`)
- Modify: `scripts/oracle/graph.json` (top level, after `segments`)
- Modify: `scripts/kb/xref.ts` (replace the `checkPartition` stub)
- Modify: `scripts/kb/xref-selftest.ts`

**Interfaces:**

- Produces: `Graph.segmentSections?: Record<string, string[]>`,
  `segmentOf(id, graph): string | null`, `segmentOfSection(section, graph): string | null`,
  `checkPartition(graph, sectionExists): Finding[]`, `const SECTION = /§(\d+(?:\.\d+)?)/g`.

- [ ] **Step 1: Type and data**

`scripts/oracle.ts`, in `Graph` after `segments?`:

```ts
  /**
   * For a split phase: segment id → the plan's numbered sections it owns (top-level numbers;
   * `20` covers `20.1`). Authored with the split; `pnpm check:kb` fails until it is complete.
   */
  segmentSections?: Record<string, string[]>;
```

`scripts/oracle/graph.json`, after the `"segments": {...}` entry:

```json
  "$segmentSectionsComment": "§→segment for split phases. A node in 5a may slice §21 for its output shape (`sections` is a manifest, not a whitelist) but its title/note may not call §21 its own without saying '5b'. pnpm check:kb asserts every § a phase-5 node cites is mapped exactly once.",
  "segmentSections": { "5a": ["18", "19", "20"], "5b": ["21", "22"] },
```

- [ ] **Step 2: Scenarios 12–13 (fixture graph + partition)**

Add the fixture graph near the top of the selftest (after `DOC`):

```ts
import type { Graph, Node } from '../oracle.ts';

function node(id: string, phase: number, title: string, note = ''): Node {
  return {
    id,
    phase,
    lane: 'engine',
    title,
    owner: 'builder',
    needs: [],
    probes: [],
    note,
  } as Node;
}
const G: Graph = {
  planRef: 'MVP_PLAN_V3.md',
  executionOrder: ['4', '5a', '5b'],
  segments: { '5a': ['p5.det-candidate'], '5b': ['p5.spike-deleted'] },
  segmentSections: { '5a': ['18', '19', '20'], '5b': ['21', '22'] },
  lanePolicy: {} as Graph['lanePolicy'],
  decisions: [],
  sections: { 'p5.det-candidate': ['18', '19', '21'], 'p5.spike-deleted': ['PHASE 0'] },
  nodes: [
    node('p4.attestation', 4, 'Cross-process attestOutcome (§14)'),
    node(
      'p5.det-candidate',
      5,
      'Deterministic candidate analyzer — §18 aggregation, §19 gates (§21 output is 5b)',
    ),
    node('p5.spike-deleted', 5, 'spike/ deleted — 5b wave 4, NOT 5a'),
  ],
};
const exists = (s: string): boolean => ['14', '18', '19', '20', '21', '22'].includes(s);
```

```ts
scenario(12, 'partition: the fixture table is complete', () => {
  const f = checkPartition(G, exists);
  return f.length === 0 ? null : `expected none, got ${f.map((x) => x.message).join(' | ')}`;
});

scenario(13, 'partition: missing segment, unknown §, and an unmapped cited § are each RED', () => {
  const has = (msgs: string[], want: string[]): string | null => {
    const missing = want.filter((w) => !msgs.some((m) => m.includes(w)));
    return missing.length === 0 && msgs.length === want.length
      ? null
      : `expected exactly [${want.join(' | ')}], got [${msgs.join(' | ')}]`;
  };
  // (i) 5b has no row; §99 is not in the plan. §21 is mapped (to 5a), so nothing about it fires.
  const a = has(
    checkPartition({ ...G, segmentSections: { '5a': ['18', '19', '21', '99'] } }, exists).map(
      (x) => x.message,
    ),
    ['no entry for segment "5b"', '§99 is mapped to 5a but is not a section'],
  );
  // (ii) both rows present, but §21 — cited by p5.det-candidate's title and slice — is unmapped.
  //      §20 is unmapped too and cited by nobody, so it must stay silent.
  const b = has(
    checkPartition({ ...G, segmentSections: { '5a': ['18', '19'], '5b': ['22'] } }, exists).map(
      (x) => x.message,
    ),
    ['p5.det-candidate (5a) cites §21, which segmentSections does not map'],
  );
  return a ?? b;
});
```

- [ ] **Step 3: Run, expect 12 to pass (stub returns []) and 13 to fail**

Run: `pnpm exec tsx scripts/kb/xref-selftest.ts`
Expected: `FAIL 13`, `12/13 passed`. (12 passing against a stub is why 13 exists.)

- [ ] **Step 4: Replace the stub**

```ts
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
```

- [ ] **Step 5: Run selftest and the live checker**

Run: `pnpm exec tsx scripts/kb/xref-selftest.ts` → `13/13 passed`.
Run: `pnpm kb xref` → `0 RED`. Then remove `"22"` from `5b` in `graph.json`, run again, expect
`RED  P  scripts/oracle/graph.json:0  p5.analysis-endpoint (5b) cites §22, which segmentSections does not map`;
restore.
Run: `pnpm check:flow` → all scenarios pass (the graph gained a key `segmentsOf()` ignores).

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write scripts/kb/xref.ts scripts/kb/xref-selftest.ts scripts/oracle.ts scripts/oracle/graph.json
pnpm exec eslint scripts/kb/xref.ts scripts/kb/xref-selftest.ts scripts/oracle.ts
git add scripts/kb/xref.ts scripts/kb/xref-selftest.ts scripts/oracle.ts scripts/oracle/graph.json
git commit -m "feat(harness): segmentSections — the §→segment partition, validated"
```

---

### Task 7: Check A — packet id vs phase/segment, block-scoped

**Files:**

- Modify: `scripts/kb/xref.ts` (replace the `checkA` stub)
- Modify: `scripts/kb/xref-selftest.ts`
- Create: `.artifacts/evidence/xref/precision-a.md`

**Interfaces:**

- Produces: `packetTokens(text): string[]`, `phaseTokens(text): string[]`,
  `checkA(file, text, graph, severity): Finding[]`.

Token grammar:

```
packet   p<digit>.<slug>(.<slug>)*   slug = [a-z0-9-]+ ; a dotted part may not be md|json|ts;
                                     NOT when followed by another dotted part, `.md|.json|.ts`,
                                     `-builder|-blocked|-design`, or preceded by `/` — those
                                     are filenames (p4.read-model.md, p4.entities-builder.json)
segment  \b(\d)(a|b)\b               5a, 5b, "5a-available"
phase    \b(?:[Pp]hase\s+|P)(\d)\b   Phase 5, P5
non-match: "5 events", "§5", "v3", "1.5", a digit inside a packet id
```

Rule: for each packet token in a non-fenced, non-historical block, if the block carries ≥1
phase/segment token and none of them equals the node's phase or segment → RED. A block that
names no node → RED. Blocks with no phase token are not assertions about phase.

- [ ] **Step 1: Scenarios 14–18**

````ts
const F2 = `- **\`pnpm lanes wave 5a\` now reports \`no outstanding work in phase 5a\`.** The one 5a
  deliverable left is \`p5.spike-deleted\`, and deleting \`spike/\` is destructive — it is the only
  on-disk record of the seven rows where the spike disagrees with the grid by design.`;

scenario(
  14,
  'tokens: filenames and selftest examples are not packet ids; digits in ids are not phases',
  () => {
    const t =
      'see p4.read-model.md, p4.read-model-builder.json, p1.debt.secrets.md, /p2.foo and p5.det-candidate';
    const got = packetTokens(t).join(',');
    const ph = phaseTokens(
      'p5.det-candidate at the 5a-available gate, Phase 4, P7, 5 events, §5, v3, 1.5',
    ).join(',');
    return got === 'p5.det-candidate' && ph === '5a,4,7'
      ? null
      : `expected p5.det-candidate / 5a,4,7 — got ${got} / ${ph}`;
  },
);

scenario(
  15,
  'F2: the b20de65 CLAUDE.md sentence is RED against a graph that puts the node in 5b',
  () => {
    const f = checkA('CLAUDE.md', F2, G, 'RED');
    return f.length === 1 &&
      /p5\.spike-deleted is 5\/5b but this block says 5a/.test(f[0]?.message ?? '')
      ? null
      : `expected one RED naming 5a, got ${JSON.stringify(f)}`;
  },
);

scenario(16, 'a contrast sentence, a bare phase, and a fenced sample are green', () => {
  const ok = [
    'p5.spike-deleted is 5b, not 5a — the graph now says so.',
    'p5.spike-deleted belongs to Phase 5.',
    '```\npnpm oracle packet p5.spike-deleted   # 5a\n```',
  ].join('\n\n');
  const f = checkA('x.md', ok, G, 'RED');
  return f.length === 0 ? null : `expected none, got ${f.map((x) => x.message).join(' | ')}`;
});

scenario(17, 'an unknown packet id is RED; a historical block is skipped', () => {
  const f = checkA(
    'x.md',
    'p2.run-liveness ships in Phase 2.\n\nAt 8ce66d5, p5.spike-deleted read as 5a.',
    G,
    'RED',
  );
  return f.length === 1 && /p2\.run-liveness names no node/.test(f[0]?.message ?? '')
    ? null
    : `expected one unknown-node RED, got ${JSON.stringify(f)}`;
});

scenario(18, 'a report-only source yields WARN, never RED', () => {
  const f = checkA('BACKLOG.md', F2, G, 'WARN');
  return f.length === 1 && f[0]?.severity === 'WARN'
    ? null
    : `expected one WARN, got ${JSON.stringify(f)}`;
});
````

- [ ] **Step 2: Run, expect 14–18 to fail (stub / missing exports)**

- [ ] **Step 3: Replace the stub**

```ts
// ── check A ───────────────────────────────────────────────────────────────────────────

const PACKET =
  /(?<![\w/.])p(\d)\.([a-z0-9-]+(?:\.(?!(?:md|json|ts)\b)[a-z0-9-]+)*)\b(?![\w-]*(?:\.[\w-]|-builder|-blocked|-design))/g;
const SEGMENT = /\b(\d)(a|b)\b/g;
const PHASE = /\b(?:[Pp]hase\s+|P)(\d)\b/g;

export function packetTokens(text: string): string[] {
  return [...text.matchAll(PACKET)].map((m) => `p${m[1]}.${m[2]}`);
}

export function phaseTokens(text: string): string[] {
  const t = text.replace(PACKET, ' '); // a digit inside a packet id is not a phase
  const out = [...t.matchAll(SEGMENT)].map((m) => `${m[1]}${m[2]}`);
  out.push(...[...t.matchAll(PHASE)].map((m) => m[1] ?? ''));
  return [...new Set(out)];
}

/**
 * A block that restates a packet's phase must restate it correctly. Naming the node's own
 * phase or segment anywhere in the block is enough — "5b, not 5a" is a contrast, not a
 * stale copy. Fenced blocks are code samples; historical blocks are history.
 */
export function checkA(file: string, text: string, graph: Graph, severity: Severity): Finding[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const out: Finding[] = [];
  for (const b of blocksOf(text)) {
    if (b.fenced || isHistorical(b.text)) continue;
    const packets = [...new Set(packetTokens(b.text))];
    if (packets.length === 0) continue;
    const phases = phaseTokens(b.text);
    for (const id of packets) {
      const n = byId.get(id);
      if (!n) {
        out.push(finding('A', severity, file, b.line, `${id} names no node in graph.json`));
        continue;
      }
      if (phases.length === 0) continue;
      const own = new Set([String(n.phase), segmentOf(id, graph) ?? String(n.phase)]);
      if (phases.some((p) => own.has(p))) continue;
      out.push(
        finding(
          'A',
          severity,
          file,
          b.line,
          `${id} is ${[...own].join('/')} but this block says ${phases.join(', ')}`,
        ),
      );
    }
  }
  return out;
}
```

- [ ] **Step 4: Run selftest → `18/18 passed`; run live and record**

Run: `pnpm kb xref | tee .artifacts/evidence/xref/run-a-initial.txt`
Expected at `130c43a`: WARN rows from `BACKLOG.md` (`p2.run-liveness`, `p2.payload-safety`,
`p2.integration-falsify`, `p7.e2e-falsify` — renamed or removed nodes) and possibly RED rows in
`docs/**` or `.claude/**`. Each RED is either a real stale restatement (fix the sentence) or a
grammar gap (fix the grammar, add a scenario). Neither is an ignore marker unless the sentence
deliberately restates history, in which case add the marker with its reason.

Write `.artifacts/evidence/xref/precision-a.md` in the same shape as `precision-c.md`. The run
must end at `0 RED` before commit.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write scripts/kb/xref.ts scripts/kb/xref-selftest.ts
pnpm exec eslint scripts/kb/xref.ts scripts/kb/xref-selftest.ts
git add scripts/kb/xref.ts scripts/kb/xref-selftest.ts .artifacts/evidence/xref/ <any docs corrected>
git commit -m "feat(harness): xref check A — packet/phase agreement, block-scoped"
```

---

### Task 8: Check B — a node's brief may not call another segment's section its own

**Files:**

- Modify: `scripts/kb/xref.ts` (replace the `checkB` stub; add `nodeFindings`, `lineOfNode`)
- Modify: `scripts/kb/xref-selftest.ts`

**Interfaces:**

- Produces: `checkB(graph, graphText): Finding[]`, `lineOfNode(graphText, id): number`,
  `nodeFindings(graph, graphText, id): Finding[]` (used by `oracle packet` in Task 9).

Rule: in a segmented node's `title`/`note`, a `§NN` whose segment ≠ the node's is RED unless
the same block carries that section's segment token. `graph.sections` is a slice manifest and
is never scanned.

- [ ] **Step 1: Scenarios 19–21 and the two live-corpus claims**

```ts
scenario(19, 'F3: a 5a title claiming "§21 output" without saying 5b is RED', () => {
  const bad: Graph = {
    ...G,
    nodes: [
      G.nodes[0] as Node,
      node(
        'p5.det-candidate',
        5,
        'Deterministic candidate analyzer — §18 aggregation, §19 gates, §21 output',
      ),
      G.nodes[2] as Node,
    ],
  };
  const f = checkB(bad, '');
  return f.length === 1 &&
    /p5\.det-candidate\.title: §21 is 5b, node is 5a/.test(f[0]?.message ?? '')
    ? null
    : `expected one RED, got ${JSON.stringify(f)}`;
});

scenario(
  20,
  'the corrected title "(§21 output is 5b)" and a same-segment § are green; sections manifest is not scanned',
  () => {
    const f = checkB(G, '');
    return f.length === 0 ? null : `expected none, got ${f.map((x) => x.message).join(' | ')}`;
  },
);

scenario(21, 'nodeFindings restricts B and P to one node', () => {
  const bad: Graph = {
    ...G,
    nodes: [
      G.nodes[0] as Node,
      node('p5.det-candidate', 5, 'x §21 output'),
      node('p5.spike-deleted', 5, 'spike/ deleted (§18)'),
    ],
  };
  const mine = nodeFindings(bad, '', 'p5.det-candidate');
  const other = nodeFindings(bad, '', 'p4.attestation');
  return mine.length === 1 && mine[0]?.check === 'B' && other.length === 0
    ? null
    : `expected one B for det-candidate and none for attestation, got ${JSON.stringify({ mine, other })}`;
});

// ── live corpus: two claims about this repository ─────────────────────────────────────

scenario(22, 'the live corpus is GREEN', () => {
  const graphText = readFileSync(join(ROOT, 'scripts/oracle/graph.json'), 'utf8');
  const graph = JSON.parse(graphText) as Graph;
  const r = run({
    fix: false,
    graph,
    graphText,
    srcs: sources(),
    tracked: trackedFiles(),
    readTarget: readTracked,
    sectionExists: (s) => sectionExistsLive(graph, s),
  });
  return r.red === 0 ? null : `${r.red} RED:\n${render(r)}`;
});

scenario(23, 'the live corpus uses at most IGNORE_CAP xref-ignore markers', () => {
  const graphText = readFileSync(join(ROOT, 'scripts/oracle/graph.json'), 'utf8');
  const graph = JSON.parse(graphText) as Graph;
  const r = run({
    fix: false,
    graph,
    graphText,
    srcs: sources(),
    tracked: trackedFiles(),
    readTarget: readTracked,
    sectionExists: (s) => sectionExistsLive(graph, s),
  });
  return r.ignores <= IGNORE_CAP ? null : `${r.ignores} ignores > cap ${IGNORE_CAP}`;
});
```

(add `readFileSync` from `node:fs`, `dirname`/`join` from `node:path`, and
`const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');` plus the new imports
`checkB, nodeFindings, run, render, sources, trackedFiles, readTracked, sectionExistsLive, IGNORE_CAP, packetTokens, phaseTokens, checkA, checkPartition` at the top.)

- [ ] **Step 2: Run, expect 19 and 21 to fail**

- [ ] **Step 3: Replace the stub and add `nodeFindings`**

```ts
// ── check B ───────────────────────────────────────────────────────────────────────────

export function lineOfNode(graphText: string, id: string): number {
  const i = graphText.indexOf(`"id": "${id}"`);
  return i < 0 ? 0 : lineOfIndex(graphText, i);
}

export function checkB(graph: Graph, graphText: string): Finding[] {
  const out: Finding[] = [];
  for (const n of graph.nodes) {
    const seg = segmentOf(n.id, graph);
    if (seg === null) continue; // an unsplit phase has nothing to disagree with
    const fields: Array<[string, string]> = [
      ['title', n.title],
      ['note', n.note ?? ''],
    ];
    for (const [field, text] of fields) {
      for (const b of blocksOf(text)) {
        const phases = phaseTokens(b.text);
        for (const m of b.text.matchAll(SECTION)) {
          const s = segmentOfSection(m[1] ?? '', graph);
          if (s === null || s === seg || phases.includes(s)) continue;
          out.push(
            finding(
              'B',
              'RED',
              GRAPH,
              lineOfNode(graphText, n.id),
              `${n.id}.${field}: §${m[1]} is ${s}, node is ${seg}, and the block does not say so`,
            ),
          );
        }
      }
    }
  }
  return out;
}

/**
 * B and P for one node — what `pnpm oracle packet` asks before it renders a brief. Check A is
 * not run on a node's own text: prepending the id to "(§21 output is 5b)" would make the
 * corrected title read as a claim that the node is 5b.
 */
export function nodeFindings(graph: Graph, graphText: string, id: string): Finding[] {
  if (!graph.nodes.some((x) => x.id === id)) return [];
  const p = checkPartition(graph, (s) => sectionExistsLive(graph, s));
  const b = checkB(graph, graphText).filter((x) => x.message.startsWith(`${id}.`));
  return [...p, ...b];
}
```

Scenario 21 calls `nodeFindings` with the fixture graph, which calls `sectionExistsLive` (kb
corpus, live): the fixture's sections 14/18–22 all exist in `MVP_PLAN_V3.md`, so `P` is empty.
If a later plan renumbers, this scenario will say so — that is the point.

- [ ] **Step 4: Run → `23/23 passed`; `pnpm kb xref` → `0 RED`**

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write scripts/kb/xref.ts scripts/kb/xref-selftest.ts
pnpm exec eslint scripts/kb/xref.ts scripts/kb/xref-selftest.ts
git add scripts/kb/xref.ts scripts/kb/xref-selftest.ts
git commit -m "feat(harness): xref check B — labelled cross-segment citations, node-scoped gate"
```

---

### Task 9: Wire it where it already runs — pre-commit, `oracle packet`, `oracle status`

**Files:**

- Modify: `scripts/precommit.ts:83-91` and the step-7 block (`:155-160`)
- Modify: `scripts/oracle.ts:626-636` (`packet`), `:325-338` (`ready`), `:947-953` (`case 'packet'`)

**Interfaces:**

- Consumes: `nodeFindings(graph, graphText, id)` from Task 8.

- [ ] **Step 1: Pre-commit — a staged document runs the checker**

`scripts/precommit.ts`, after `const harnessTouched = …;`:

```ts
// The edit that moves a line number is a document edit. The harness predicate above never
// sees one, so the cross-reference check gets its own, cheaper trigger.
const docsTouched = staged.some((f) => f.endsWith('.md') && !f.startsWith('.artifacts/'));
```

Replace step 7:

```ts
// 7. Cross-references whenever a document or the graph is staged; harness selftests only
//    when the harness itself is.
if (harnessTouched || docsTouched) {
  step('kb xref', () => run('pnpm', ['kb', 'xref']));
}
if (harnessTouched) {
  step('check:lanes', () => run('pnpm', ['check:lanes']));
  step('check:flow', () => run('pnpm', ['check:flow']));
  step('check:kb', () => run('pnpm', ['check:kb']));
}
```

- [ ] **Step 2: `oracle packet` refuses a stale brief**

`scripts/oracle.ts`: add `import { nodeFindings } from './kb/xref.ts';` next to the other
imports. In `packet()`, after `const graph = loadGraph();`:

```ts
const gate = nodeFindings(graph, readFileSync(GRAPH_PATH, 'utf8'), id);
if (gate.length > 0) {
  return [
    `# REFUSED — the brief for ${id} disagrees with the graph`,
    '',
    ...gate.map((g) => `- ${g.check}  ${g.message}`),
    '',
    'Fix scripts/oracle/graph.json (title, note, or segmentSections) and re-run. A brief that',
    'restates a phase wrongly is how spike/ nearly died at the 5a gate.',
  ].join('\n');
}
```

In `main()`'s `case 'packet'`:

```ts
    case 'packet': {
      if (!arg) {
        console.error('usage: pnpm oracle packet <node-id>');
        process.exit(1);
      }
      const text = packet(byId, arg);
      if (text.startsWith('# REFUSED')) {
        console.error(text);
        process.exit(1);
      }
      console.log(text);
      break;
    }
```

- [ ] **Step 3: `oracle status` names the gate a "ready" node is behind**

`scripts/oracle.ts`, before `function ready(`:

```ts
/**
 * `executionOrder` gates a node its `needs` edges do not: `p5.spike-deleted` is READY by
 * dependency the moment 5a lands, and is still behind Phase 4. Say so where an agent reads it.
 */
function gatedAfter(byId: Map<string, Resolved>, graph: Graph, n: Resolved): string | null {
  const order = graph.executionOrder ?? [];
  const segs = graph.segments ?? {};
  const segOf = (x: Resolved): string =>
    Object.entries(segs).find(([, ids]) => ids.includes(x.id))?.[0] ?? String(x.phase);
  const mine = order.indexOf(segOf(n));
  if (mine < 0) return null;
  const all = [...byId.values()];
  for (let i = 0; i < mine; i += 1) {
    const seg = order[i] ?? '';
    if (all.some((x) => x.state !== 'DONE' && segOf(x) === seg)) return seg;
  }
  return null;
}
```

Replace the body of `ready()` (`scripts/oracle.ts:325-338`) with:

```ts
function ready(byId: Map<string, Resolved>): string {
  const graph = loadGraph();
  const rows = [...byId.values()]
    .filter((n) => n.readiness === 'READY' || n.readiness === 'IN-PROGRESS')
    .sort((a, b) => a.phase - b.phase || a.depth - b.depth);
  if (rows.length === 0)
    return '  nothing unblocked — resolve open decisions or finish in-flight work';
  return rows
    .map((n) => {
      const gate = gatedAfter(byId, graph, n);
      return (
        `  [P${n.phase} ${n.lane.padEnd(11)}] ${n.readiness === 'IN-PROGRESS' ? '~' : '+'} ${n.id.padEnd(23)} ${n.title}` +
        (n.owner !== 'builder' ? `  (owner: ${n.owner})` : '') +
        (gate ? `  (gated: after ${gate})` : '')
      );
    })
    .join('\n');
}
```

- [ ] **Step 4: Prove all three**

Run: `pnpm oracle status`
Expected: `+ p5.spike-deleted … (gated: after 4)` and `+ p5.rec-persistence … (gated: after 4)`;
`p4.attestation` carries no annotation.

Run: `pnpm oracle packet p5.det-candidate` → the brief, exit 0. Then edit `graph.json` to make
its title `… §21 output` (drop "is 5b"), run again:

```
# REFUSED — the brief for p5.det-candidate disagrees with the graph

- B  p5.det-candidate.title: §21 is 5b, node is 5a, and the block does not say so
```

exit 1. Restore the title.

Pre-commit: `git add CLAUDE.md` after a whitespace-only edit, `git commit -m tmp` → the hook
prints `kb xref` as a step; `git reset --soft HEAD~1`, restore the file.

Run: `pnpm check:flow && pnpm check:probes && pnpm check:kb` — all green.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write scripts/precommit.ts scripts/oracle.ts
pnpm exec eslint scripts/precommit.ts scripts/oracle.ts
git add scripts/precommit.ts scripts/oracle.ts
git commit -m "feat(harness): xref runs on staged docs, gates oracle packet, annotates gated nodes"
```

---

### Task 10: History replay

**Files:**

- Create: `scripts/kb/xref-replay.ts`
- Create: `.artifacts/evidence/xref/replay.md`

**Interfaces:**

- Consumes: `run`, `modeOf`, `Source`, `Graph` from `./xref.ts`.

Replay only commits that touched `scripts/oracle/graph.json` or `MVP_PLAN_V3.md` — the drift
events — reading every file through `git show <commit>:<path>` (no worktrees). History carries
no bound fragments and, before Task 6, no `segmentSections`, so replay measures bare-existence,
A, and B-with-whatever-partition-existed. Say so in the record.

- [ ] **Step 1: Write it**

```ts
/**
 * Replay the cross-reference checker over the commits that changed the graph or the plan.
 * Output: a markdown table for .artifacts/evidence/xref/replay.md. Verdicts are added by hand.
 *
 *   tsx scripts/kb/xref-replay.ts > .artifacts/evidence/xref/replay.md
 */
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { modeOf, run, type Source } from './xref.ts';
import type { Graph } from '../oracle.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (args: string): string =>
  execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const commits = git(
  'log --format=%h|%ad|%s --date=short --reverse -- scripts/oracle/graph.json MVP_PLAN_V3.md',
)
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => {
    const [h = '', d = '', ...s] = l.split('|');
    return { h, d, s: s.join('|') };
  });

console.log('# Cross-reference replay\n');
console.log(
  `Commits touching graph.json or MVP_PLAN_V3.md: ${commits.length}. Measures bare-existence, A, and B; history has no bound fragments.\n`,
);
console.log('| commit | date | subject | RED | WARN | first findings | verdict |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');

for (const c of commits) {
  const tracked = git(`ls-tree -r --name-only ${c.h}`).trim().split(/\r?\n/);
  const show = (f: string): string | null => {
    try {
      return git(`show ${c.h}:${f}`);
    } catch {
      return null;
    }
  };
  const graphText = show('scripts/oracle/graph.json');
  if (graphText === null) continue;
  const graph = JSON.parse(graphText) as Graph;
  const srcs: Source[] = [];
  for (const f of tracked) {
    if (!f.endsWith('.md')) continue;
    const mode = modeOf(f);
    if (mode === 'skip') continue;
    const text = show(f);
    if (text !== null) srcs.push({ file: f, text, mode });
  }
  srcs.push({ file: 'scripts/oracle/graph.json', text: graphText, mode: 'red' });
  const r = run({
    fix: false,
    graph,
    graphText,
    srcs,
    tracked,
    readTarget: show,
    sectionExists: () => true,
  });
  const first = r.findings
    .filter((f) => f.severity === 'RED')
    .slice(0, 3)
    .map((f) => `${f.check} ${f.file}:${f.line} ${f.message}`)
    .join('<br>');
  console.log(
    `| ${c.h} | ${c.d} | ${c.s.replace(/\|/g, '/')} | ${r.red} | ${r.findings.length - r.red} | ${first} | |`,
  );
}
```

- [ ] **Step 2: Run it**

Run: `pnpm exec tsx scripts/kb/xref-replay.ts > .artifacts/evidence/xref/replay.md`
Expected: one row per commit; takes a few minutes (one `git show` per file per commit).

- [ ] **Step 3: Verdicts**

Fill the `verdict` column for every row with RED > 0: `real` (a wrong restatement that was
live at that commit — name it), `grammar` (a token the grammar misreads — file a scenario), or
`noise`. Add a `## Summary` with the counts and the hit rate: RED rows that are `real` ÷ commits.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write scripts/kb/xref-replay.ts
pnpm exec eslint scripts/kb/xref-replay.ts
git add scripts/kb/xref-replay.ts .artifacts/evidence/xref/replay.md
git commit -m "feat(harness): xref replay over graph/plan commits, hit rate recorded"
```

---

### Task 11: Fold the corrections back into the spec

**Files:**

- Modify: `docs/specs/2026-08-18-cross-reference-checker.md`
- Modify: `BACKLOG.md` (only if Task 5 left "step 10" pointing at a renumbered list)

- [ ] **Step 1: Edit the spec**

- Status line: `Status: accepted, built 2026-09-xx per docs/specs/2026-09-01-cross-reference-checker-plan.md.`
- `## What the council got wrong`: append one paragraph — `segments` was added to `graph.json`
  on <date of the commit that added it: `git log --format='%h %ad' --date=short -S'"segments"' -- scripts/oracle/graph.json | tail -1`>;
  the checker derives sub-phase from it and the `subphase` field was never authored.
- `### Data prerequisite`: replace "Add an optional `subphase` field…" with "Sub-phase is
  `graph.segments`; the table is `graph.segmentSections`, validated by `checkPartition`
  (`scripts/kb/xref.ts`)."
- `### Check A`: replace the sentence-scope paragraph with block scope and the rule "RED only
  when no phase/segment token in the block is the node's own"; replace the suppression
  paragraph with the two in-document exemptions and `IGNORE_CAP`.
- `### Check B`: "Applies to the node's `title` and `note`. `graph.sections` is a slice
  manifest and is never scanned. A cross-segment §NN is RED unless the block names that
  section's segment."
- `### Check C`: add the grammar block from Task 2, `--fix`, and basename resolution. Delete
  the claim that `CLAUDE.md:288` is bound; replace with "`CLAUDE.md:291` was bare and green;
  Task 5 bound it."
- `## What proves it works`: F2 = `b20de65:CLAUDE.md:277-278` (quote it); FC/FC-bare/FC-fix
  are inline fixtures in `scripts/kb/xref-selftest.ts`; evidence dir `.artifacts/evidence/xref/`.
- `## Cost`: "Not a phase" stays; drop the Phase 1/2 sentence.
- `## Still open`: replace with "Closed — no list; see `IGNORE_CAP`."
- `## Implementation steps`: replace with a pointer to this plan; mark the BACKLOG filing done.

- [ ] **Step 2: Check the spec against the checker it describes**

Run: `pnpm kb xref` → `0 RED` (the spec cites itself and `CLAUDE.md`; every citation must
resolve). Run: `pnpm kb search "cross-reference checker"` → the spec ranks first, untagged.

- [ ] **Step 3: Commit**

```bash
git add docs/specs/2026-08-18-cross-reference-checker.md BACKLOG.md
git commit -m "docs: cross-reference checker spec revised to what was built"
```

---

## Not in this plan

- **Check D** (banned-phrase scan for the slice of defect 1 that has a signature) — small, but
  it is a fourth rule with its own precision to measure; file it in `BACKLOG.md` if wanted.
- **`@COMMIT` resolution via `git show`** — today an `@COMMIT` citation is simply exempt; the
  corpus has none, so verifying them is YAGNI until one exists.
- **Wave tokens** ("wave 4" → 5b) — needs a wave→segment table nobody has asked for.

## Self-review

- Spec coverage: data prerequisite → T6; Check A → T7; Check B → T8; Check C both forms → T3;
  historical/commit-qualified → T3; where it runs (`check:kb`, `oracle packet`, pre-commit) →
  T4/T9; fixtures F2/F3/FC/FC-bare → T7/T8/T3; precision record → T4/T7; history replay →
  T10; BACKLOG filings → already done, verified in T5/T11; "no fifth check:*" → `kb xref` is
  a subcommand, `check:kb` unchanged in name.
- Names used across tasks: `blocksOf`, `blockAt`, `normalize`, `lineOfIndex`, `Citation`,
  `parseCitations`, `resolvePath`, `trackedFiles`, `Finding`, `Severity`, `isHistorical`,
  `ignoreReason`, `hasIgnoreMarker`, `checkC`, `applyFixes`, `modeOf`, `Source`, `sources`,
  `readTracked`, `sectionExistsLive`, `checkPartition`, `checkA`, `checkB`, `packetTokens`,
  `phaseTokens`, `segmentOf`, `segmentOfSection`, `SECTION`, `lineOfNode`, `nodeFindings`,
  `run`, `render`, `cli`, `IGNORE_CAP`, `GRAPH` — each defined once, in the task listed above.
- Check A never runs on `graph.json` (neither in `run()` nor in `nodeFindings()`); a node's own
  phase claims are covered by Check B's segment labelling and by `check:flow`'s segment
  membership. If a note like "5a wave 1" on a 5b node ever bites, that is a new rule with its
  own fixture, not a widening of this one.
- Five defects were found and fixed in this plan's own self-review before it was saved: the
  packet regex swallowed `.md`; scenario 13 could not pass as first written; a JSON source
  would have been one block; Task 1 carried unused imports; per-node Check A misread the
  corrected `p5.det-candidate` title. Expect the same rate from the code — run every scenario
  red before green.
