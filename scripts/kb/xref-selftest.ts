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
